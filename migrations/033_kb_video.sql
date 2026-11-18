-- Migration 033: video transcripts in the knowledge base (subtitles -> FFmpeg+VAD+Gemini -> whisper.cpp fallback).

-- Which transcription path a video took, and the link to its transcript document.
ALTER TABLE youtube_videos ADD COLUMN IF NOT EXISTS kb_document_id bigint;
ALTER TABLE youtube_videos ADD COLUMN IF NOT EXISTS transcript_source varchar(24);   -- subtitles | auto_subtitles | gemini_audio | whisper
ALTER TABLE youtube_videos ADD COLUMN IF NOT EXISTS kb_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE youtube_videos ADD COLUMN IF NOT EXISTS kb_error text;
CREATE INDEX IF NOT EXISTS idx_youtube_videos_kb_queue ON youtube_videos (worth_score DESC, published_at DESC) WHERE status = 'queued_kb';

-- Statements from the single Flash-Lite analysis of a transcript, with the original timecode of the moment.
CREATE TABLE IF NOT EXISTS kb.video_claims (
  id bigserial PRIMARY KEY,
  document_id bigint NOT NULL REFERENCES kb.documents(id) ON DELETE CASCADE,
  t_sec integer NOT NULL,
  speaker text,
  speaker_entity_id bigint REFERENCES kb.entities(id) ON DELETE SET NULL,
  text text NOT NULL,
  quote text,
  modality varchar(12) NOT NULL DEFAULT 'claim' CHECK (modality IN ('fact', 'plan', 'claim', 'speculation', 'denial', 'question')),
  value_num numeric,
  value_unit varchar(24),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_kb_video_claims_doc ON kb.video_claims (document_id, t_sec);
CREATE INDEX IF NOT EXISTS idx_kb_video_claims_speaker ON kb.video_claims (speaker_entity_id) WHERE speaker_entity_id IS NOT NULL;
