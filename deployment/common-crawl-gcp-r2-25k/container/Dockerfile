# The release build script requires a digest-pinned base image argument. This
# avoids treating a mutable Python tag as a reviewed production artifact.
ARG PYTHON_IMAGE
FROM ${PYTHON_IMAGE}
ARG PYTHON_IMAGE
ARG GROWTHSENT_RELEASE_SHA256

WORKDIR /opt/growthsent
COPY requirements.txt /opt/growthsent/requirements.txt
RUN test -n "${PYTHON_IMAGE}" && python -m pip install --no-cache-dir --disable-pip-version-check -r requirements.txt
COPY tools/ /opt/growthsent/tools/
COPY runners/ /opt/growthsent/runners/
COPY manifests/ /opt/growthsent/manifests/
COPY config/ /opt/growthsent/config/
COPY BUNDLE-MANIFEST.json /opt/growthsent/BUNDLE-MANIFEST.json
RUN test -n "${PYTHON_IMAGE}" \
 && test "${GROWTHSENT_RELEASE_SHA256}" != "" \
 && printf '%s\n' "${GROWTHSENT_RELEASE_SHA256}" | grep -Eq '^[0-9a-f]{64}$' \
 && printf '%s\n' "${GROWTHSENT_RELEASE_SHA256}" > /opt/growthsent/RELEASE-ARCHIVE-SHA256 \
 && chmod 0444 /opt/growthsent/RELEASE-ARCHIVE-SHA256 \
 && chmod 0555 /opt/growthsent/runners/*.sh
ENV PYTHONUNBUFFERED=1
ENTRYPOINT ["/bin/bash"]
