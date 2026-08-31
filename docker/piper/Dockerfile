FROM python:3.11-slim

# onnxruntime (usado pelo Piper) precisa da libgomp.
RUN apt-get update \
 && apt-get install -y --no-install-recommends libgomp1 ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir \
      piper-tts==1.2.0 \
      fastapi==0.115.6 \
      uvicorn==0.34.0

WORKDIR /app
COPY server.py .

ENV PIPER_VOICE=pt_BR-faber-medium \
    PIPER_VOICE_DIR=/voices

EXPOSE 5000
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "5000"]
