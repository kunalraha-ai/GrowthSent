FROM python:3.12-slim@sha256:593bd06efe90efa80dc4eee3948be7c0fde4134606dd40d8dd8dbcade98e669c

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN apt-get update -qq \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Keep the image minimal: only what the builder needs.
RUN python -m pip install \
        boto3==1.43.67 \
        botocore==1.43.67 \
        duckdb==1.2.2 \
        s3transfer==0.19.2

WORKDIR /opt/growthsent
COPY tools/build_domain_json_v1.py /opt/growthsent/tools/build_domain_json_v1.py
COPY tools/common_crawl_r2_store.py /opt/growthsent/tools/common_crawl_r2_store.py
COPY container_entrypoint.py /opt/growthsent/container_entrypoint.py

ENTRYPOINT ["/bin/bash"]
