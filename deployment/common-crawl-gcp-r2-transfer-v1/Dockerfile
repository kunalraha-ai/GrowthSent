FROM python:3.12-slim@sha256:593bd06efe90efa80dc4eee3948be7c0fde4134606dd40d8dd8dbcade98e669c

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1

RUN apt-get update -qq \
 && apt-get install -y --no-install-recommends rclone curl jq ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN python -m pip install --no-cache-dir --disable-pip-version-check \
        google-cloud-secret-manager \
        requests

WORKDIR /opt/growthsent
COPY runners/transfer.py /opt/growthsent/runners/transfer.py

ENTRYPOINT ["/bin/bash"]
