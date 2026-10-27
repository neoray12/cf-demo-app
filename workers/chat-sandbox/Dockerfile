# -python variant required: the base image lacks the Python interpreter runtime
# used by runCode() (SandboxError: "Python interpreter not available").
# Must match the @cloudflare/sandbox version in package.json.
FROM docker.io/cloudflare/sandbox:0.12.14-python

# Image ships Python 3 + Node.js + the code-interpreter runtime.
# Data-analysis stack for the CSV/XLSX upload + executeCode workflow.
RUN pip3 install --no-cache-dir pandas openpyxl matplotlib

# Egress control (src/index.ts, interceptHttps = true): all HTTPS from the
# container is re-signed with an ephemeral Containers CA. The sandbox runtime
# appends that CA to the system bundle at start (SANDBOX_INTERCEPT_HTTPS=1), but
# requests/pip ship their own certifi bundle and Node its own store — point them
# all at the system bundle, which also keeps the public roots. Never bake the
# CA itself into the image: it is generated per container start.
ENV SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt \
    REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt \
    PIP_CERT=/etc/ssl/certs/ca-certificates.crt \
    CURL_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt \
    NODE_EXTRA_CA_CERTS=/etc/cloudflare/certs/cloudflare-containers-ca.crt

EXPOSE 8000
