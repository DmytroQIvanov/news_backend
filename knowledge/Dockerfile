# One image, several workers (collector / nlp / maintain / connectors / video) selected by the command.

# whisper.cpp (fallback transcription for the video worker). Skipped with --build-arg WITH_WHISPER=0.
FROM debian:bookworm-slim AS whisper
ARG WITH_WHISPER=1
ARG WHISPER_CPP_REF=v1.7.6
RUN mkdir -p /opt/whisper && if [ "$WITH_WHISPER" = "1" ]; then       apt-get update && apt-get install -y --no-install-recommends build-essential cmake git ca-certificates curl       && git clone --depth 1 --branch "$WHISPER_CPP_REF" https://github.com/ggml-org/whisper.cpp /src       && cmake -S /src -B /src/build -DBUILD_SHARED_LIBS=OFF -DWHISPER_BUILD_TESTS=OFF -DCMAKE_BUILD_TYPE=Release       && cmake --build /src/build -j --config Release --target whisper-cli       && cp /src/build/bin/whisper-cli /opt/whisper/       && curl -fsSL -o /opt/whisper/ggml-base.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin;     fi

FROM python:3.12-slim AS base

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1 \
    KB_MODEL_DIR=/models HF_HOME=/models/hf

WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install -r requirements.txt

# spaCy pipelines baked into the image (small, CPU-friendly). Swap for *_md/_lg via build args for higher NER quality.
ARG SPACY_MODELS="en_core_web_sm uk_core_news_sm de_core_news_sm xx_ent_wiki_sm"
RUN for m in $SPACY_MODELS; do python -m spacy download "$m"; done

# Embedding model is downloaded at build time so containers start offline and fast.
ARG KB_EMBED_MODEL=sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2
ENV KB_EMBED_MODEL=${KB_EMBED_MODEL} KB_EMBED_CACHE=/opt/fastembed
RUN mkdir -p /opt/fastembed && python -c "from fastembed import TextEmbedding; TextEmbedding(model_name='${KB_EMBED_MODEL}', cache_dir='/opt/fastembed')"

COPY kb ./kb

RUN useradd --create-home --uid 10001 kb && mkdir -p /models && chown -R kb /models /opt/fastembed
USER kb

ENTRYPOINT ["/usr/bin/tini", "--", "python", "-m", "kb"]
CMD ["stats"]
