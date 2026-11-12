# The Next.js web app (landing page, Cosign console, PayPal data pages, AG Studio dashboard).
FROM oven/bun:1-slim AS base
WORKDIR /app

# Step 1: Install dependencies using Bun
FROM base AS deps
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Step 2: Build the application using Bun
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN bun run build

# Step 3: Production runtime with Bun
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production PORT=3000
ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/package.json ./package.json

EXPOSE 3000

CMD ["sh", "-c", "bun --bun next start -p ${PORT:-3000}"]
