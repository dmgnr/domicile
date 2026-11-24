# The relay's image for fly.io; built from the repository's root, which
# holds the Cargo workspace. See fly.toml.
# The newest Rust 1.x, which meets the workspace's `rust-version` as it moves.
FROM rust:1-slim-bookworm AS build
WORKDIR /src
COPY . .
RUN cargo build --release --locked -p domicile-relay

FROM debian:bookworm-slim
COPY --from=build /src/target/release/domicile-relay /usr/local/bin/domicile-relay
ENTRYPOINT ["domicile-relay"]
CMD ["--zone", "mcp.domicile-desktop.com"]
