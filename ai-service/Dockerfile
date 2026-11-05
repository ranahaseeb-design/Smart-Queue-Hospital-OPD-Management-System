# Smart OPD AI service (internal; only the backend should reach port 8000).
FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    MODELS_DIR=/app/models \
    HOSPITAL_TZ=Asia/Karachi

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app
COPY scripts ./scripts
RUN mkdir -p /app/models && useradd --create-home --uid 10001 aiservice && chown -R aiservice /app
USER aiservice

# Every /ai/* call needs X-AI-Service-Token == AI_SERVICE_TOKEN: pass it at run time
# (docker run -e AI_SERVICE_TOKEN=...). Without it the /ai/* endpoints answer 503.
# 0.0.0.0 is the container interface; publish 8000 only on the backend's internal network.

# Model files should survive container restarts: mount a volume on /app/models.
VOLUME ["/app/models"]
EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
