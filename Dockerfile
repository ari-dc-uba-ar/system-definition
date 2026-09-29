ARG NODE_IMAGE=node:24.21.0-bookworm-slim
FROM ${NODE_IMAGE}

WORKDIR /workspace

RUN apt-get update \
    && apt-get install -y --no-install-recommends postgresql-client \
    && rm -rf /var/lib/apt/lists/*

ENV CI=true

# Install dependencies without running this package's "prepare" script.
# "prepare" runs tsc, and migration tasks intentionally need to be able to
# build an image while a TDD acceptance test is still red.
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY . .

CMD ["npm", "test"]
