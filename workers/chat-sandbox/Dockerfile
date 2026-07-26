# -python variant required: the base image lacks the Python interpreter runtime
# used by runCode() (SandboxError: "Python interpreter not available")
FROM docker.io/cloudflare/sandbox:0.8.9-python

# Image ships Python 3 + Node.js + the code-interpreter runtime.
# Keep lean for fast cold starts — add pip packages here only when demand shows up:
# RUN pip3 install --no-cache-dir numpy pandas

EXPOSE 8000
