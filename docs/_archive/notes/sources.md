# CX04 Sources

## Official

- https://github.com/smol-machines/smolvm
- https://github.com/smol-machines/smolvm/releases (v0.1.16)
- https://smolmachines.com
- https://smolmachines.com/docs/sandbox/
- https://smolmachines.com/docs/microvm/

## SDK Pages (Empty / Non-functional)

- https://smolmachines.com/sdk/api-sandbox — claims TS SDK, npm 404
- https://smolmachines.com/sdk/api-microvm — claims TS SDK, npm 404
- https://smolmachines.com/sdk/api-container — claims TS SDK, npm 404

## Actual API (Discovered via Testing)

- `smolvm serve` → REST API on localhost:8080
- OpenAPI 3.1 spec: `GET /api-docs/openapi.json`
- Swagger UI: `GET /swagger-ui/`
- Source: `smolvm-repo/src/api/` (Rust/axum)

## Related Projects

- https://github.com/slp/krunvm — krunvm by libkrun creator
- https://github.com/containers/libkrun — lightweight VM library
- https://github.com/containers/crun — OCI container runtime used by smolvm
