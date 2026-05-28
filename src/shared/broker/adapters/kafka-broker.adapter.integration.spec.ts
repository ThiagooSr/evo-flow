/**
 * Integration tests for KafkaBrokerAdapter against a real Kafka broker.
 *
 * Opt-in: set `KAFKA_INTEGRATION=1` to enable. Otherwise this file describes
 * a single skipped suite so the runner doesn't fail in CI without Kafka.
 *
 * Local setup:
 *   docker compose -f docker/docker-compose.kafka.yml up -d
 *   KAFKA_INTEGRATION=1 npm test -- kafka-broker.adapter.integration.spec
 */
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { Kafka } from 'kafkajs';
import { KafkaBrokerAdapter } from './kafka-broker.adapter';
import { BrokerMetrics } from '../metrics/broker-metrics';
import { BrokerMessage } from '../interfaces/message-broker.interface';

const integrationEnabled = process.env.KAFKA_INTEGRATION === '1';
const describeIntegration = integrationEnabled ? describe : describe.skip;

describeIntegration('KafkaBrokerAdapter (integration)', () => {
  const brokers = process.env.KAFKA_BROKERS ?? 'localhost:9092';
  let adapter: KafkaBrokerAdapter;
  let close: () => Promise<void>;
  const topicSuffix = Date.now();

  async function buildLiveAdapter(env: Record<string, string>) {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [() => env],
        }),
      ],
      providers: [BrokerMetrics, KafkaBrokerAdapter],
    }).compile();
    const built = moduleRef.get(KafkaBrokerAdapter);
    return {
      adapter: built,
      close: () => moduleRef.close(),
    };
  }

  beforeAll(async () => {
    const setup = await buildLiveAdapter({
      BROKER_TYPE: 'kafka',
      KAFKA_BROKERS: brokers,
      RUN_MODE: 'integration-test',
    });
    adapter = setup.adapter;
    close = setup.close;
    await (
      adapter as unknown as { onModuleInit: () => Promise<void> }
    ).onModuleInit();
  }, 60_000);

  afterAll(async () => {
    if (!adapter) return;
    await (
      adapter as unknown as { onModuleDestroy: () => Promise<void> }
    ).onModuleDestroy();
    if (close) await close();
  }, 30_000);

  it('AC1: publish → consumer receives JSON payload', async () => {
    const topic = `int-publish-${topicSuffix}`;
    const received: BrokerMessage<{ foo: string }>[] = [];

    await adapter.subscribe<{ foo: string }>(topic, (msg) => {
      received.push(msg);
      return adapter.ack(msg);
    });

    await adapter.publish(topic, { foo: 'bar' });

    await waitFor(() => received.length > 0, 15_000);
    expect(received[0].payload.foo).toBe('bar');
    expect(received[0].headers.correlationId).toEqual(expect.any(String));
    expect(received[0].headers.messageId).toEqual(expect.any(String));
  }, 30_000);

  it('AC2: nack(requeue=true) causes re-delivery', async () => {
    const topic = `int-nack-${topicSuffix}`;
    let firstSeen: BrokerMessage<{ n: number }> | null = null;
    const deliveries: number[] = [];

    await adapter.subscribe<{ n: number }>(topic, async (msg) => {
      deliveries.push(msg.payload.n);
      if (firstSeen === null) {
        firstSeen = msg;
        await adapter.nack(msg, true);
        return;
      }
      await adapter.ack(msg);
    });

    await adapter.publish(topic, { n: 42 });

    await waitFor(() => deliveries.length >= 2, 20_000);
    expect(deliveries[0]).toBe(42);
    expect(deliveries[1]).toBe(42); // re-delivered after nack(requeue=true)
  }, 30_000);
});

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

// Touch the Kafka import so tree-shaking / lint don't drop it; we rely on the
// real client being importable in the integration build path.
void Kafka;
