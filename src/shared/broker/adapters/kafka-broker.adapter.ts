import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Admin,
  Consumer,
  EachMessagePayload,
  Kafka,
  KafkaConfig,
  Producer,
  SASLOptions,
} from 'kafkajs';
import { randomUUID } from 'crypto';
import { CustomLoggerService } from 'src/common/services/custom-logger.service';
import {
  BrokerMessage,
  IMessageBroker,
} from '../interfaces/message-broker.interface';
import { BrokerType } from '../types/broker-type.enum';
import { BrokerMetrics } from '../metrics/broker-metrics';

const CLIENT_ID = 'evo-flow-broker';
const DEFAULT_NUM_PARTITIONS = 12;
const DEFAULT_REPLICATION_FACTOR = 1;
const BACKOFF_STEPS_MS = [0, 1000, 2000, 4000, 8000, 15000];
const TOPIC_ALREADY_EXISTS_PATTERN = /already exists/i;
const SUPPORTED_SASL_MECHANISMS = new Set([
  'plain',
  'scram-sha-256',
  'scram-sha-512',
]);
const BROKER_LABEL = 'kafka';

type SaslMechanism = 'plain' | 'scram-sha-256' | 'scram-sha-512';

interface AckHandle {
  topic: string;
  partition: number;
  offset: string;
  consumer: Consumer;
}

@Injectable()
export class KafkaBrokerAdapter
  implements IMessageBroker, OnModuleInit, OnModuleDestroy
{
  private readonly logger = new CustomLoggerService(KafkaBrokerAdapter.name);

  private kafka: Kafka | null = null;
  private producer: Producer | null = null;
  private admin: Admin | null = null;
  private readonly consumers = new Map<string, Consumer>();
  private readonly pendingAcks = new WeakMap<BrokerMessage, AckHandle>();
  private active = false;

  constructor(
    private readonly config: ConfigService,
    private readonly metrics: BrokerMetrics,
  ) {}

  async onModuleInit(): Promise<void> {
    const brokerType = this.config.get<string>('BROKER_TYPE');
    if (brokerType !== BrokerType.KAFKA) {
      // Adapter is registered but a different broker is active. Stay dormant.
      return;
    }

    this.kafka = this.buildKafkaClient();
    this.admin = this.kafka.admin();
    this.producer = this.kafka.producer({ idempotent: true });

    await this.connectWithBackoff();
    this.active = true;
    this.logger.log('broker.boot', {
      action: 'broker.boot',
      broker: BROKER_LABEL,
    });
  }

  async onModuleDestroy(): Promise<void> {
    if (!this.active) return;

    for (const [topic, consumer] of this.consumers.entries()) {
      try {
        await consumer.disconnect();
      } catch (err) {
        this.logger.warn(
          `KafkaBrokerAdapter consumer disconnect failed for "${topic}": ${(err as Error).message}`,
        );
      }
    }
    this.consumers.clear();

    try {
      await this.producer?.disconnect();
    } catch (err) {
      this.logger.warn(
        `KafkaBrokerAdapter producer disconnect failed: ${(err as Error).message}`,
      );
    }
    try {
      await this.admin?.disconnect();
    } catch (err) {
      this.logger.warn(
        `KafkaBrokerAdapter admin disconnect failed: ${(err as Error).message}`,
      );
    }

    this.active = false;
  }

  async publish<T>(topic: string, payload: T): Promise<void> {
    this.assertActive('publish');

    const correlationId = randomUUID();
    const messageId = randomUUID();
    const value = JSON.stringify(payload);

    await this.producer!.send({
      topic,
      messages: [
        {
          value,
          headers: {
            correlationId,
            messageId,
            'content-type': 'application/json',
          },
        },
      ],
    });

    this.logger.log('broker.publish', {
      action: 'broker.publish',
      broker: BROKER_LABEL,
      topic,
      correlationId,
      messageId,
    });
  }

  async subscribe<T>(
    topic: string,
    handler: (msg: BrokerMessage<T>) => Promise<void>,
  ): Promise<void> {
    this.assertActive('subscribe');

    if (this.consumers.has(topic)) {
      throw new Error(
        `KafkaBrokerAdapter already has a consumer registered for topic "${topic}".`,
      );
    }

    await this.ensureTopicExists(topic);

    const runMode = this.config.get<string>('RUN_MODE') ?? 'single';
    const groupId = `${runMode}-${topic}`;
    const consumer = this.kafka!.consumer({ groupId });

    await consumer.connect();
    await consumer.subscribe({ topic, fromBeginning: false });

    await consumer.run({
      autoCommit: false,
      eachMessage: async (payload) =>
        this.dispatchMessage(consumer, payload, handler),
    });

    this.consumers.set(topic, consumer);
    this.logger.log('broker.subscribe', {
      action: 'broker.subscribe',
      broker: BROKER_LABEL,
      topic,
      groupId,
    });
  }

  async ack(msg: BrokerMessage): Promise<void> {
    const handle = this.pendingAcks.get(msg);
    if (!handle) {
      throw new Error(
        `KafkaBrokerAdapter.ack called on unknown message id="${msg.id}". Was the message produced by this adapter's subscribe?`,
      );
    }

    await handle.consumer.commitOffsets([
      {
        topic: handle.topic,
        partition: handle.partition,
        offset: String(Number(handle.offset) + 1),
      },
    ]);

    this.pendingAcks.delete(msg);
    this.logger.log('broker.ack', {
      action: 'broker.ack',
      broker: BROKER_LABEL,
      topic: handle.topic,
      correlationId: msg.headers.correlationId,
      messageId: msg.headers.messageId,
    });
  }

  async nack(msg: BrokerMessage, requeue: boolean = true): Promise<void> {
    const handle = this.pendingAcks.get(msg);
    if (!handle) {
      throw new Error(
        `KafkaBrokerAdapter.nack called on unknown message id="${msg.id}". Was the message produced by this adapter's subscribe?`,
      );
    }

    if (requeue) {
      // Re-deliver via Kafka's own machinery: rewind the consumer to the
      // original offset so the next poll re-fetches this message. We do NOT
      // commit so a consumer crash before the next fetch still re-delivers.
      handle.consumer.seek({
        topic: handle.topic,
        partition: handle.partition,
        offset: handle.offset,
      });
      this.pendingAcks.delete(msg);
      this.logger.log('broker.nack.requeue', {
        action: 'broker.nack.requeue',
        broker: BROKER_LABEL,
        topic: handle.topic,
        correlationId: msg.headers.correlationId,
        messageId: msg.headers.messageId,
      });
      return;
    }

    await handle.consumer.commitOffsets([
      {
        topic: handle.topic,
        partition: handle.partition,
        offset: String(Number(handle.offset) + 1),
      },
    ]);
    this.metrics.terminalFailures.inc({
      broker: BROKER_LABEL,
      topic: handle.topic,
    });
    this.pendingAcks.delete(msg);
    this.logger.log('broker.nack.terminal', {
      action: 'broker.nack.terminal',
      broker: BROKER_LABEL,
      topic: handle.topic,
      correlationId: msg.headers.correlationId,
      messageId: msg.headers.messageId,
    });
  }

  private async dispatchMessage<T>(
    consumer: Consumer,
    payload: EachMessagePayload,
    handler: (msg: BrokerMessage<T>) => Promise<void>,
  ): Promise<void> {
    const { topic, partition, message } = payload;
    const headers = this.decodeHeaders(message.headers);

    let parsed: T;
    try {
      parsed = JSON.parse(message.value?.toString('utf8') ?? 'null') as T;
    } catch (err) {
      // Poison pill: skip the message permanently to keep the consumer moving.
      this.logger.error(
        `broker.consume.poison topic="${topic}" partition=${partition} offset=${message.offset}: ${(err as Error).message}`,
      );
      this.metrics.terminalFailures.inc({ broker: BROKER_LABEL, topic });
      await consumer.commitOffsets([
        { topic, partition, offset: String(Number(message.offset) + 1) },
      ]);
      return;
    }

    const brokerMsg: BrokerMessage<T> = {
      id: `${topic}/${partition}/${message.offset}`,
      payload: parsed,
      headers,
      raw: message,
    };
    this.pendingAcks.set(brokerMsg, {
      topic,
      partition,
      offset: message.offset,
      consumer,
    });

    this.logger.log('broker.consume', {
      action: 'broker.consume',
      broker: BROKER_LABEL,
      topic,
      partition,
      offset: message.offset,
      correlationId: headers.correlationId,
      messageId: headers.messageId,
    });

    try {
      await handler(brokerMsg);
    } catch (err) {
      // Handler did not ack/nack — leave the offset uncommitted so Kafka
      // re-delivers on the next session. Surface the error for visibility.
      this.logger.error(
        `broker.consume.handler_error topic="${topic}" offset=${message.offset}: ${(err as Error).message}`,
      );
    }
  }

  private decodeHeaders(
    raw: EachMessagePayload['message']['headers'],
  ): Record<string, string> {
    const out: Record<string, string> = {};
    if (!raw) return out;
    for (const [key, value] of Object.entries(raw)) {
      if (value == null) continue;
      out[key] = Buffer.isBuffer(value)
        ? value.toString('utf8')
        : String(value);
    }
    return out;
  }

  private async ensureTopicExists(topic: string): Promise<void> {
    try {
      await this.admin!.createTopics({
        topics: [
          {
            topic,
            numPartitions: DEFAULT_NUM_PARTITIONS,
            replicationFactor: DEFAULT_REPLICATION_FACTOR,
          },
        ],
        waitForLeaders: true,
      });
    } catch (err) {
      const message = (err as Error).message ?? '';
      if (TOPIC_ALREADY_EXISTS_PATTERN.test(message)) return;
      throw err;
    }
  }

  private buildKafkaClient(): Kafka {
    const brokersRaw = this.config.get<string>('KAFKA_BROKERS') ?? '';
    const brokers = brokersRaw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    if (brokers.length === 0) {
      throw new Error(
        'KAFKA_BROKERS must be a comma-separated list of host:port pairs.',
      );
    }

    const sslEnabled =
      String(
        this.config.get<string>('KAFKA_SSL_ENABLED') ?? '',
      ).toLowerCase() === 'true';

    const kafkaConfig: KafkaConfig = {
      clientId: CLIENT_ID,
      brokers,
      ssl: sslEnabled,
      sasl: this.buildSaslConfig(),
    };

    return new Kafka(kafkaConfig);
  }

  private buildSaslConfig(): SASLOptions | undefined {
    const mechanism = (
      this.config.get<string>('KAFKA_SASL_MECHANISM') ?? ''
    ).toLowerCase();
    const username = this.config.get<string>('KAFKA_SASL_USERNAME');
    const password = this.config.get<string>('KAFKA_SASL_PASSWORD');

    if (!mechanism && !username && !password) return undefined;

    if (!SUPPORTED_SASL_MECHANISMS.has(mechanism)) {
      throw new Error(
        `KAFKA_SASL_MECHANISM="${mechanism}" is not supported. Use one of: plain, scram-sha-256, scram-sha-512.`,
      );
    }
    if (!username || !password) {
      throw new Error(
        'KAFKA_SASL_USERNAME and KAFKA_SASL_PASSWORD are required when KAFKA_SASL_MECHANISM is set.',
      );
    }

    return {
      mechanism: mechanism as SaslMechanism,
      username,
      password,
    } as SASLOptions;
  }

  private async connectWithBackoff(): Promise<void> {
    let lastErr: Error | null = null;
    for (const wait of BACKOFF_STEPS_MS) {
      if (wait > 0) await this.sleep(wait);
      try {
        await this.admin!.connect();
        await this.producer!.connect();
        return;
      } catch (err) {
        lastErr = err as Error;
        this.logger.warn(
          `KafkaBrokerAdapter connect attempt failed (waited ${wait}ms): ${lastErr.message}`,
        );
      }
    }
    throw new Error(
      `KafkaBrokerAdapter failed to connect after 30s retry budget: ${lastErr?.message ?? 'unknown error'}`,
    );
  }

  private assertActive(op: string): void {
    if (!this.active) {
      throw new Error(
        `KafkaBrokerAdapter.${op} called before adapter became active. Set BROKER_TYPE=kafka and ensure onModuleInit completed.`,
      );
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
