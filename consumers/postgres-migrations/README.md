# PostgreSQL migrations consumer

Consumer package for immutable migration/release artifacts and PostgreSQL integration.
It is built and tested separately from the root TypeScript program; production code imports the public `system-definition` package API rather than private root sources.
