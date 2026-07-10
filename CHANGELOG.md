# Changelog

All notable changes to Evo Flow will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [v1.0.0-rc6] - 2026-07-04

First tagged release of `evo-flow`, joining the Evo CRM Community family versioning at rc6.

### Added

- Initial public release of `evo-flow` as part of the Evo CRM Community family.
- Campaigns, journeys, segments, events, click-tracking and processing modules built on NestJS, Postgres, ClickHouse, Kafka, Redis and Temporal.
- Integration with `evo-auth-service-community` for token validation and with `evo-ai-crm-community` (Rails) as the source-of-truth for contacts, labels, users and custom attributes.
- Single-account architecture: no multi-tenancy at the evo-flow layer; account scoping is handled upstream by the CRM via JWT claims.
- Shared HTTP clients: `src/shared/crm-client/` (CRM Rails) and `src/shared/auth-client/` (evo-auth-service).
- `/health` and `/ready` endpoints per `RUN_MODE`, with Temporal-connectivity readiness indicator and journey-execution queue-health observability.
- Docker image build/push CI pipeline.

### Fixed

- Journey engine hardening: write-through session persistence to Postgres, idempotent trigger dedup by message id, multi-output wait routing, split-node variant routing, conditional matching for legacy handles, and journey-variable interpolation across all node executors.
- ClickHouse Kafka-engine queues recreated when the broker address changes (contact events and journey triggers).
- CRM client resilience: 404 responses no longer trip the ContactsClient circuit breaker; label removal by name no longer wipes the whole label set; contact custom attributes written by slug and merged instead of replaced.
- TLS support for Redis connections across services.

## Support

- **Issues**: [GitHub Issues](https://github.com/evolution-foundation/evo-flow/issues)
- **Security**: see [SECURITY.md](SECURITY.md)
- **Trademarks**: see [TRADEMARKS.md](TRADEMARKS.md)
