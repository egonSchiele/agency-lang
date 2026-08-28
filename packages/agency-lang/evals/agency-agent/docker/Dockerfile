# The image every agency-agent eval runs in. The agent writes and runs
# Python here, so the container is the safety boundary; nothing outside the
# mounted run directory is reachable. Build with `make eval-image`, which
# packs the working tree into the tarball this copies, so the image tests
# the code you have, not a published release.
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-venv python3-pip openssl sqlite3 jq curl ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m pip install --break-system-packages --no-cache-dir pytest==8.4.1

# The tarball is the last layer: an agent change rebuilds only this step.
COPY agency-lang.tgz /tmp/agency-lang.tgz
RUN npm i -g /tmp/agency-lang.tgz && rm /tmp/agency-lang.tgz && agency --version

WORKDIR /work
