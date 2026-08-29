FROM python@sha256:593bd06efe90efa80dc4eee3948be7c0fde4134606dd40d8dd8dbcade98e669c

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/opt/growthsent/tools

WORKDIR /opt/growthsent

COPY requirements.txt /opt/growthsent/requirements.txt
RUN pip install --no-cache-dir --disable-pip-version-check -r /opt/growthsent/requirements.txt

COPY tools /opt/growthsent/tools
COPY reference-manifest.json /opt/growthsent/reference-manifest.json
COPY container_entry.py /opt/growthsent/container_entry.py
COPY run-canary.sh /usr/local/bin/run-growthsent-ten-wat-canary
RUN chmod 0555 /usr/local/bin/run-growthsent-ten-wat-canary && \
    useradd --create-home --uid 10001 --shell /usr/sbin/nologin growthsent && \
    mkdir -p /work && chown -R growthsent:growthsent /opt/growthsent /work

USER growthsent
ENTRYPOINT ["/usr/local/bin/run-growthsent-ten-wat-canary"]
