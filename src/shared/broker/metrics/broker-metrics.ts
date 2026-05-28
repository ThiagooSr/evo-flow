import { Injectable } from '@nestjs/common';
import { Counter, register } from 'prom-client';

const TERMINAL_FAILURES_METRIC = 'evo_broker_terminal_failures_total';

@Injectable()
export class BrokerMetrics {
  public readonly terminalFailures: Counter<string>;

  constructor() {
    const existing = register.getSingleMetric(TERMINAL_FAILURES_METRIC) as
      | Counter<string>
      | undefined;

    this.terminalFailures =
      existing ??
      new Counter({
        name: TERMINAL_FAILURES_METRIC,
        help: 'Total broker messages that exhausted retries and were dropped (nack with requeue=false).',
        labelNames: ['broker', 'topic'],
      });
  }
}
