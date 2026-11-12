FROM python:3.12-slim
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
COPY pyproject.toml ./
COPY cosign_agent ./cosign_agent
COPY evals ./evals
COPY replay ./replay
# Loading the OCR engine once at build time proves its bundled models and native libraries work
# in this image, so a photographed invoice never fails for the first time in front of a user.
RUN pip install --no-cache-dir . \
    && python -c "from rapidocr import RapidOCR; RapidOCR()" \
    && useradd --system --uid 10002 agent
USER agent
ENV PORT=8000 COSIGN_LLM_MODE=replay
EXPOSE 8000
CMD ["sh", "-c", "uvicorn cosign_agent.app:app --host 0.0.0.0 --port ${PORT}"]
