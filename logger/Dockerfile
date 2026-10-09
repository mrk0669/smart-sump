# Smart Sump logger. Built from the repo root (see docker-compose.yml).
FROM python:3.12-slim

WORKDIR /app
COPY logger/requirements.txt logger/requirements.txt
RUN pip install --no-cache-dir -r logger/requirements.txt

COPY logger/ logger/
COPY config/ config/

# Print logs straight away instead of buffering them.
ENV PYTHONUNBUFFERED=1
EXPOSE 8000
CMD ["python", "-m", "logger", "--host", "0.0.0.0", "--port", "8000"]
