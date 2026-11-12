FROM rust:1-bookworm AS build
WORKDIR /app
# Cache dependencies separately from the source.
COPY Cargo.toml Cargo.lock ./
RUN mkdir -p src/bin && echo "fn main() {}" > src/main.rs && echo "fn main() {}" > src/bin/spike.rs && echo "" > src/lib.rs \
    && cargo build --release --locked 2>/dev/null || true
COPY build.rs ./build.rs
COPY src ./src
COPY migrations ./migrations
COPY openapi.json ./openapi.json
RUN touch src/main.rs src/lib.rs && cargo build --release --locked --bin cosign-core --bin cosign-spike

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 cosign
COPY --from=build /app/target/release/cosign-core /usr/local/bin/cosign-core
COPY --from=build /app/target/release/cosign-spike /usr/local/bin/cosign-spike
USER cosign
ENV PORT=8080
EXPOSE 8080
CMD ["cosign-core"]
