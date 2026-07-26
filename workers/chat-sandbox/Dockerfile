# -python variant required: the base image lacks the Python interpreter runtime
# used by runCode() (SandboxError: "Python interpreter not available")
FROM docker.io/cloudflare/sandbox:0.8.9-python

# Image ships Python 3 + Node.js + the code-interpreter runtime.
# Data-analysis stack for the CSV/XLSX upload + executeCode workflow.
RUN pip3 install --no-cache-dir pandas openpyxl matplotlib

EXPOSE 8000
