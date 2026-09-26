# PostgreSQL migrations consumer

Consumer package for immutable migration/release artifacts and PostgreSQL integration.
It is built and tested separately from the root TypeScript program; production code imports the public `system-definition` package API rather than private root sources.

The checkout declares `system-definition` as a local package dependency. `prebuild`/`pretest` run `scripts/bootstrap-repository.js`, which only links this repository root into the root `node_modules`; it performs no network install. The root suite compiles the public package before entering the consumer suite.

Published SQL resources are byte-addressed UTF-8/LF artifacts. They are validated and never normalized on load.
