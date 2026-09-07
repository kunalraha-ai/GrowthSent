# Build from the repository root so the verified source manifest and shared
# immutable R2 helper are copied directly from their canonical locations.
ARG PYTHON_IMAGE=python@sha256:593bd06efe90efa80dc4eee3948be7c0fde4134606dd40d8dd8dbcade98e669c
FROM ${PYTHON_IMAGE}
ARG PYTHON_IMAGE
ARG GROWTHSENT_RELEASE_SHA256

WORKDIR /opt/growthsent
COPY deployment/common-crawl-gcp-link-index-v1/requirements.txt /opt/growthsent/requirements.txt
RUN test -n "${PYTHON_IMAGE}" && python -m pip install --no-cache-dir --disable-pip-version-check -r requirements.txt
COPY tools/common_crawl_r2_store.py /opt/growthsent/tools/common_crawl_r2_store.py
COPY tools/common_crawl_gcp_secret_runtime.py /opt/growthsent/tools/common_crawl_gcp_secret_runtime.py
COPY tools/common_crawl_link_index_catalog_v1.py /opt/growthsent/tools/common_crawl_link_index_catalog_v1.py
COPY tools/common_crawl_link_index_materialize_v1.py /opt/growthsent/tools/common_crawl_link_index_materialize_v1.py
COPY tools/common_crawl_link_index_compact_v1.py /opt/growthsent/tools/common_crawl_link_index_compact_v1.py
COPY deployment/common-crawl-gcp-link-index-v1/runners/ /opt/growthsent/runners/
COPY deployment/common-crawl-gcp-link-index-v1/config/ /opt/growthsent/config/
COPY deployment/common-crawl-production-v2/manifests/cc-main-2026-30-first-100000.json /opt/growthsent/manifests/cc-main-2026-30-first-100000.json
# Fail the image build, before any Batch VM is allocated, if the pinned DuckDB
# release cannot honor the bounded partitioned-write contract used by materialization.
RUN python -c "import duckdb, shutil; connection = duckdb.connect(); connection.execute('SET partitioned_write_max_open_files=1024'); connection.execute(\"COPY (SELECT 1 AS value, 1 AS payload) TO '/tmp/growthsent-duckdb-proof' (FORMAT PARQUET, PARTITION_BY (value), PER_THREAD_OUTPUT FALSE, OVERWRITE_OR_IGNORE TRUE)\"); shutil.rmtree('/tmp/growthsent-duckdb-proof')"
RUN test -n "${PYTHON_IMAGE}" \
 && test "${GROWTHSENT_RELEASE_SHA256}" != "" \
 && printf '%s\n' "${GROWTHSENT_RELEASE_SHA256}" | grep -Eq '^[0-9a-f]{64}$' \
 && printf '%s\n' "${GROWTHSENT_RELEASE_SHA256}" > /opt/growthsent/RELEASE-SHA256 \
 && chmod 0444 /opt/growthsent/RELEASE-SHA256 \
 && chmod 0555 /opt/growthsent/runners/*.sh
ENV PYTHONUNBUFFERED=1
ENTRYPOINT ["/bin/bash"]
