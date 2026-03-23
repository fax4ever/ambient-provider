# SPDX-FileCopyrightText: Copyright (c) 2024-2025 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Automatic Speech Recognition service using NVIDIA Riva."""
import io
import os
# Configure numba/librosa caching before importing librosa to avoid Docker issues
# Don't disable JIT entirely as it breaks librosa, just fix the caching
os.environ['NUMBA_CACHE_DIR'] = '/tmp/numba_cache'  # Set writable cache directory
os.environ['NUMBA_DISABLE_CACHING'] = '1'  # Disable caching to avoid permission issues

# Ensure cache directory exists and is writable
import pathlib
pathlib.Path('/tmp/numba_cache').mkdir(parents=True, exist_ok=True)

import librosa
import soundfile as sf
import riva.client
import riva.client.proto.riva_asr_pb2 as rasr
from pathlib import Path
from typing import List, AsyncGenerator, Dict, Any
import uuid
from datetime import datetime
from collections import Counter
import asyncio

from ambient_scribe.models import Transcript, TranscriptSegment
from ambient_scribe.deps import Settings
import json


def serialize_for_json(data: Dict[str, Any]) -> Dict[str, Any]:
    """Convert datetime objects to ISO format strings for JSON serialization."""
    serialized = {}
    for key, value in data.items():
        if isinstance(value, datetime):
            serialized[key] = value.isoformat()
        else:
            serialized[key] = value
    return serialized

async def detect_speaker_roles(transcript: Transcript, settings: Settings) -> dict:
    """Simple LLM call to detect which speaker ID is patient vs provider."""
    try:
        from openai import AsyncOpenAI
        
        # Prepare sample text from first few segments
        sample_segments = []
        for segment in transcript.segments[:10]:  # First 10 segments only
            if segment.speaker_tag is not None:
                sample_segments.append(f"Speaker {segment.speaker_tag}: {segment.text}")
        
        if not sample_segments:
            return {}

        sample_text = "\n".join(sample_segments)
                
        prompt = f"""Analyze this medical conversation and determine which speaker is the patient and which is the provider/doctor. The speaker that is not the patient is most likely the doctor, so be generous.

{sample_text}

Return only a JSON object: {{"patient": speaker_number, "provider": speaker_number}}"""

        client = AsyncOpenAI(
            api_key=settings.nvidia_api_key,
            base_url=settings.openai_base_url
        )
        response = await client.chat.completions.create(
            model=settings.llm_model,
            messages=[
                {"role": "system", "content": "You are a medical transcript analyzer. Return only JSON."},
                {"role": "user", "content": prompt}
            ],
            temperature=0.1,
            max_tokens=50
        )
        
        result_text = response.choices[0].message.content.strip()
        print(f"DEBUG: Speaker role detection result: {result_text}")
        result_json = json.loads(result_text)
        
        # Convert to our format: {speaker_id: "patient"/"provider"}
        speaker_roles = {}
        if "patient" in result_json:
            speaker_roles[result_json["patient"]] = "patient"
        if "provider" in result_json:
            speaker_roles[result_json["provider"]] = "provider"
            
        return speaker_roles
        
    except Exception as e:
        print(f"Warning: Speaker role detection failed: {e}")
        return {}

async def transcribe_audio_file(
    file_path: Path,
    transcript_id: str,
    filename: str,
    settings: Settings
) -> Transcript:
    """Transcribe an audio file using NVIDIA Riva ASR."""
    
    try:
        # Convert audio to WAV format if needed
        audio_data = convert_to_wav(file_path)
        
        # Set up Riva client
        if settings.self_hosted:
            print(f"Using self-hosted Riva URI: {settings.riva_uri}")
            auth = riva.client.Auth(uri=settings.riva_uri)
        else:
            if not (settings.riva_function_id or "").strip():
                raise ValueError(
                    "RIVA_FUNCTION_ID is required for cloud Riva. "
                    "Set it in your environment or .env, or use self-hosted Riva (SELF_HOSTED=true)."
                )
            print(f"Using NVIDIA Riva URI: {settings.riva_uri}")
            auth = riva.client.Auth(
                uri=settings.riva_uri,
                use_ssl=True,
                metadata_args=[
                    ["function-id", settings.riva_function_id.strip()],
                    ["authorization", f"Bearer {settings.nvidia_api_key}"]
                ]
            )
        
        # Create ASR service with timeout options
        asr_service = riva.client.ASRService(auth)
        
        # Configure recognition
        config = riva.client.RecognitionConfig(
            language_code=settings.riva_language,
            max_alternatives=1,
            enable_automatic_punctuation=True,
            enable_word_time_offsets=True,
            model=settings.riva_model
        )
        
        # Set audio encoding parameters
        enc_enum = rasr.RecognitionConfig.DESCRIPTOR.fields_by_name['encoding'].enum_type
        config.encoding = enc_enum.values_by_name['LINEAR_PCM'].number
        config.sample_rate_hertz = 16000
        config.audio_channel_count = 1
        
        # Always enable speaker diarization to ensure UI can separate speakers
        riva.client.add_speaker_diarization_to_config(config, True, 2) # 2 is just a hint, it is possible riva gives more
        
        # Get audio bytes
        audio_data.seek(0)
        audio_bytes = audio_data.read()
        
        if len(audio_bytes) == 0:
            raise ValueError("Empty audio buffer")
        
        # Perform transcription
        response = asr_service.offline_recognize(audio_bytes, config)
        
        # Convert response to our format
        segments = process_riva_response(response)
                
        # Calculate total duration
        duration = segments[-1].end if segments else 0.0
        
        # Create transcript
        transcript = Transcript(
            id=transcript_id,
            segments=segments,
            language=settings.riva_language,
            duration=duration,
            filename=filename,
            created_at=datetime.now()
        )
                
        # Detect speaker roles
        transcript.speaker_roles = await detect_speaker_roles(transcript, settings)
        
        print(f"DEBUG: Transcript speaker roles: {transcript.speaker_roles}")
        
        return transcript
        
    except Exception as e:
        raise Exception(f"ASR transcription failed: {str(e)}")

async def stream_transcribe_audio_file(
    file_path: Path,
    transcript_id: str,
    filename: str,
    settings: Settings
) -> AsyncGenerator[dict, None]:
    """Stream transcribe an audio file using NVIDIA Riva ASR with real-time updates."""
    
    try:
        # Check if streaming is enabled
        if not settings.enable_streaming:
            # Fall back to regular transcription
            print(f"Streaming is disabled, falling back to regular transcription")
            transcript = await transcribe_audio_file(file_path, transcript_id, filename, settings)
            transcript_dict = serialize_for_json(transcript.dict())
            
            yield {
                "type": "final",
                "transcript": transcript_dict
            }
            return

        # Set up Riva client
        if settings.self_hosted:
            print(f"Using self-hosted Riva URI for streaming: {settings.riva_uri}")
            auth = riva.client.Auth(uri=settings.riva_uri)
        else:
            if not (settings.riva_function_id or "").strip():
                raise ValueError(
                    "RIVA_FUNCTION_ID is required for cloud Riva. "
                    "Set it in your environment or .env, or use self-hosted Riva (SELF_HOSTED=true)."
                )
            print(f"Using NVIDIA Riva URI for streaming: {settings.riva_uri}")
            auth = riva.client.Auth(
                uri=settings.riva_uri,
                use_ssl=True,
                metadata_args=[
                    ["function-id", settings.riva_function_id.strip()],
                    ["authorization", f"Bearer {settings.nvidia_api_key}"]
                ]
            )
        asr_service = riva.client.ASRService(auth)

        # Handle audio format - convert MP3 to WAV if needed
        audio_file_to_use = str(file_path)
        temp_wav_file = None
        
        if str(file_path).endswith('.mp3'):
            print(f"Converting MP3 to WAV for streaming: {file_path}")
            y, sr = librosa.load(str(file_path), sr=16000, mono=True)
            wav_file = str(file_path).replace('.mp3', '_temp.wav')
            sf.write(wav_file, y, sr)
            audio_file_to_use = wav_file
            temp_wav_file = wav_file
            print(f"Temporary WAV file created: {wav_file}")

        # Configure streaming recognition
        config = riva.client.StreamingRecognitionConfig(
            config=riva.client.RecognitionConfig(
                language_code=settings.riva_language,
                max_alternatives=1,
                enable_automatic_punctuation=True,
                enable_word_time_offsets=True,
                sample_rate_hertz=16000,
                audio_channel_count=1,
                model=settings.riva_model
            ),
            interim_results=True,
        )

        # Enable speaker diarization
        riva.client.add_speaker_diarization_to_config(config, True, 2)

        print(f"Starting streaming transcription of: {audio_file_to_use}")
        
        # Process streaming results
        current_speaker = None
        accumulated_text = ""
        processed_finals = set()
        segments = []

        try:
            with riva.client.AudioChunkFileIterator(
                audio_file_to_use, settings.streaming_chunk_size
            ) as audio_chunk_iterator:
                
                for response in asr_service.streaming_response_generator(
                    audio_chunks=audio_chunk_iterator,
                    streaming_config=config,
                ):
                    if not response.results:
                        continue
                    
                    for result in response.results:
                        if not result.alternatives:
                            continue
                            
                        alternative = result.alternatives[0]
                        transcript = alternative.transcript.strip()
                        
                        if not transcript:
                            continue
                        
                        # Get speaker info
                        speaker = "Speaker"
                        if hasattr(alternative, 'words') and alternative.words:
                            speaker_tags = []
                            for word in alternative.words:
                                if hasattr(word, 'speaker_tag'):
                                    speaker_tags.append(word.speaker_tag)
                            
                            if speaker_tags:
                                most_common_speaker = Counter(speaker_tags).most_common(1)[0][0]
                                speaker = f"Speaker {most_common_speaker}"
                        
                        if result.is_final:
                            # Create a unique key for this final result
                            result_key = f"{speaker}:{transcript}"
                            
                            # Skip if we've already processed this exact final result
                            if result_key in processed_finals:
                                continue
                                
                            processed_finals.add(result_key)
                            
                            # Create transcript segment for final result
                            start_time = 0.0
                            end_time = 0.0
                            confidence = 0.95
                            
                            if hasattr(alternative, 'words') and alternative.words:
                                words = alternative.words
                                if words:
                                    try:
                                        start_time = extract_time(words[0].start_time)
                                        end_time = extract_time(words[-1].end_time)
                                        confidences = [getattr(word, 'confidence', 1.0) for word in words if getattr(word, 'confidence', None) is not None]
                                        confidence = sum(confidences) / len(confidences) if confidences else 0.95
                                    except:
                                        pass
                            
                            # Extract speaker number
                            speaker_tag = 0
                            try:
                                if speaker.startswith("Speaker "):
                                    speaker_tag = int(speaker.split(" ")[1])
                            except:
                                speaker_tag = 0
                            
                            segment = TranscriptSegment(
                                start=start_time,
                                end=max(end_time, start_time),
                                text=transcript,
                                speaker_tag=speaker_tag,
                                confidence=confidence
                            )
                            segments.append(segment)
                                                        
                            # Yield final segment
                            yield {
                                "type": "final_segment",
                                "segment": segment.dict(),
                                "speaker": speaker,
                                "speaker_tag": speaker_tag
                            }
                            
                        else:
                            # Yield partial result
                            yield {
                                "type": "partial",
                                "text": transcript,
                                "speaker": speaker,
                            }
                            
                        # Small delay to prevent overwhelming the client
                        await asyncio.sleep(0.01)

        finally:
            # Clean up temporary WAV file if we created one
            if temp_wav_file and Path(temp_wav_file).exists():
                Path(temp_wav_file).unlink()
                print(f"Cleaned up temporary file: {temp_wav_file}")

        # Create final transcript object
        duration = segments[-1].end if segments else 0.0
        
        transcript_obj = Transcript(
            id=transcript_id,
            segments=segments,
            language=settings.riva_language,
            duration=duration,
            filename=filename,
            created_at=datetime.now()
        )
        
        # Detect speaker roles
        # transcript_obj.speaker_roles = await detect_speaker_roles(transcript_obj, settings)
        
        # Yield complete transcript
        transcript_dict = serialize_for_json(transcript_obj.dict())
        
        yield {
            "type": "complete",
            "transcript": transcript_dict
        }
        
        print("Streaming transcription completed.")
        
    except Exception as e:
        yield {
            "type": "error",
            "error": f"Streaming transcription failed: {str(e)}"
        }
        raise Exception(f"Streaming ASR transcription failed: {str(e)}")

def extract_time(time_obj) -> float:
    """Extract time from Riva time object."""
    try:
        if hasattr(time_obj, 'seconds') and hasattr(time_obj, 'nanos'):
            seconds = getattr(time_obj, 'seconds', None)
            nanos = getattr(time_obj, 'nanos', None)
            if seconds is not None and nanos is not None:
                return max(0.0, seconds + nanos / 1e9)
        
        if isinstance(time_obj, (int, float)):
            return max(0.0, float(time_obj))
        
        if hasattr(time_obj, 'total_seconds'):
            return max(0.0, time_obj.total_seconds())
            
    except Exception:
        pass
    
    return 0.0

def convert_to_wav(file_path: Path) -> io.BytesIO:
    """Convert audio file to WAV format suitable for Riva."""
    
    try:
        # Load audio with librosa (supports many formats)
        y, sr = librosa.load(str(file_path), sr=None)
        
        # Resample to 16kHz if needed
        if sr != 16000:
            y = librosa.resample(y, orig_sr=sr, target_sr=16000)
            sr = 16000
        
        # Convert to mono if stereo
        if len(y.shape) > 1:
            y = librosa.to_mono(y)
        
        # Write to buffer
        wav_buffer = io.BytesIO()
        sf.write(wav_buffer, y, sr, format='wav')
        wav_buffer.seek(0)
        
        return wav_buffer
        
    except Exception as e:
        raise Exception(f"Audio conversion failed: {str(e)}")

def process_riva_response(response) -> List[TranscriptSegment]:
    """Process Riva ASR response into transcript segments."""
    
    print(f"DEBUG: Riva response: {response}")
    
    segments = []
    
    # Group words by consecutive speaker tag
    word_groups = []
    current_speaker = None
    current_words = []

    try:
        for result in response.results:
            # If words list is missing, skip grouping for this result
            words_list = getattr(result.alternatives[0], 'words', []) or []
            
            # First pass: collect all words and infer missing speaker tags
            processed_words = []
            last_known_speaker = None
            
            for word in words_list:
                # Check if word has explicit speaker_tag
                if hasattr(word, 'speaker_tag') and word.speaker_tag is not None:
                    speaker = word.speaker_tag
                    last_known_speaker = speaker
                else:
                    # Word doesn't have speaker_tag, use last known speaker or default to 1
                    speaker = last_known_speaker if last_known_speaker is not None else 1
                    print(f"DEBUG: Word '{getattr(word, 'word', '')}' missing speaker_tag, assigned to speaker {speaker}")
                
                processed_words.append((word, speaker))
            
            # Second pass: group by consecutive speaker
            for word, speaker in processed_words:
                if speaker != current_speaker:
                    if current_words:
                        word_groups.append((current_speaker, current_words))
                    current_speaker = speaker
                    current_words = [word]
                else:
                    current_words.append(word)

        if current_words:
            word_groups.append((current_speaker, current_words))

        # Convert word groups to segments, tolerating missing timestamps
        for speaker, words in word_groups:
            if not words:
                continue

            def safe_time(get_time_attr):
                try:
                    t = get_time_attr()
                    print(f"DEBUG: Time object: {t}, type: {type(t)}")
                    
                    # Try different ways to extract time
                    if hasattr(t, 'seconds') and hasattr(t, 'nanos'):
                        seconds = getattr(t, 'seconds', None)
                        nanos = getattr(t, 'nanos', None)
                        if seconds is not None and nanos is not None:
                            time_val = seconds + nanos / 1e9
                            print(f"DEBUG: Extracted time from seconds/nanos: {time_val}s")
                            
                            # Validate the timestamp - should be reasonable for a conversation (< 1 hour typically)
                            if time_val > 3600:  # More than 1 hour
                                print(f"DEBUG: Timestamp too large ({time_val}s), might be in wrong units")
                                
                                # Try different conversion factors
                                candidates = [
                                    (1000, 'milliseconds'),
                                    (1000000, 'microseconds'),
                                    (1000000000, 'nanoseconds'),
                                    (60, 'minutes')  # Sometimes Riva returns minutes instead of seconds
                                ]
                                
                                for factor, name in candidates:
                                    converted = time_val / factor
                                    if 0 <= converted <= 3600:  # Reasonable range: 0 to 1 hour
                                        time_val = converted
                                        print(f"DEBUG: Converted from {name}: {time_val}s")
                                        break
                                
                                # If still unreasonable, return 0 to trigger estimation
                                if time_val > 3600:
                                    print(f"DEBUG: Could not convert large timestamp, returning 0")
                                    return 0.0
                            
                            return max(0.0, time_val)
                    
                    # Try if it's already a float/int
                    if isinstance(t, (int, float)):
                        time_val = float(t)
                        print(f"DEBUG: Direct numeric time: {time_val}s")
                        
                        # Apply the same validation
                        if time_val > 3600:
                            print(f"DEBUG: Direct timestamp too large ({time_val}s), trying conversions")
                            
                            # Try different conversion factors
                            candidates = [
                                (1000, 'milliseconds'),
                                (1000000, 'microseconds'),
                                (1000000000, 'nanoseconds'),
                                (60, 'minutes')
                            ]
                            
                            for factor, name in candidates:
                                converted = time_val / factor
                                if 0 <= converted <= 3600:
                                    time_val = converted
                                    print(f"DEBUG: Converted from {name}: {time_val}s")
                                    break
                            
                            if time_val > 3600:
                                return 0.0
                        
                        return max(0.0, time_val)
                    
                    # Try if it has a total_seconds method
                    if hasattr(t, 'total_seconds'):
                        time_val = t.total_seconds()
                        print(f"DEBUG: total_seconds(): {time_val}s")
                        return max(0.0, time_val)
                        
                    print(f"DEBUG: No valid time extraction method found for: {t}")
                except Exception as e:
                    print(f"DEBUG: Exception in safe_time: {e}")
                    
                return 0.0

            start_time = safe_time(lambda: words[0].start_time)
            end_time = safe_time(lambda: words[-1].end_time)
            text = ' '.join([getattr(word, 'word', '') for word in words]).strip()

            confidences = [getattr(word, 'confidence', 1.0) for word in words if getattr(word, 'confidence', None) is not None]
            avg_confidence = sum(confidences) / len(confidences) if confidences else 1.0

            segments.append(TranscriptSegment(
                start=start_time,
                end=max(end_time, start_time),
                text=text,
                speaker_tag=speaker if speaker is not None else 0,
                confidence=avg_confidence
            ))
    except Exception:
        pass

    # If we still have no segments, try to parse from transcript text that includes labels like 'speaker_1: '
    if not segments:
        full_text = " ".join([
            getattr(result.alternatives[0], 'transcript', '')
            for result in getattr(response, 'results', [])
        ]).strip()
        if full_text:
            import re
            pattern = re.compile(r"(?:^|\n)\s*(speaker[_\s-]?(\d+))\s*:\s*", re.IGNORECASE)
            parts = pattern.split(full_text)
            # parts will be like [pre, 'speaker_1', '1', text1, 'speaker_2', '2', text2, ...]
            if len(parts) > 1:
                it = iter(parts)
                preface = next(it, '')  # text before first label
                # If there is preface text, keep as unlabeled first segment
                if preface.strip():
                    segments.append(TranscriptSegment(start=0.0, end=0.0, text=preface.strip(), speaker_tag=0, confidence=1.0))
                while True:
                    try:
                        _label = next(it)
                        speaker_num_str = next(it)
                        body = next(it)
                        speaker_num = int(speaker_num_str) if speaker_num_str and speaker_num_str.isdigit() else 0
                        if body.strip():
                            segments.append(TranscriptSegment(start=0.0, end=0.0, text=body.strip(), speaker_tag=speaker_num, confidence=1.0))
                    except StopIteration:
                        break
            else:
                # Final fallback: single segment
                segments.append(TranscriptSegment(start=0.0, end=0.0, text=full_text, speaker_tag=0, confidence=1.0))
    
    # Post-process to add estimated timestamps if all are 0
    segments = add_estimated_timestamps(segments)
    
    # Post-process to fix inconsistent timestamps
    segments = fix_inconsistent_timestamps(segments)
    
    return segments


def fix_inconsistent_timestamps(segments: List[TranscriptSegment]) -> List[TranscriptSegment]:
    """Fix timestamps that are inconsistent or out of sequence."""
    
    if len(segments) < 2:
        return segments
    
    print("DEBUG: Checking for inconsistent timestamps")
    
    # Look for patterns that suggest wrong units or inconsistent timing
    issues_found = []
    
    for i in range(1, len(segments)):
        prev_segment = segments[i-1]
        curr_segment = segments[i]
        
        # Check for time going backwards (should always increase)
        if curr_segment.start < prev_segment.start:
            issues_found.append(f"Time goes backwards: {prev_segment.start:.1f}s -> {curr_segment.start:.1f}s")
        
        # Check for unreasonably large jumps (> 30 minutes between segments)
        time_gap = curr_segment.start - prev_segment.start
        if time_gap > 1800:  # 30 minutes
            issues_found.append(f"Large time gap: {time_gap:.1f}s between segments {i-1} and {i}")
        
        # Check for segments that are very long (> 5 minutes)
        duration = curr_segment.end - curr_segment.start
        if duration > 300:  # 5 minutes
            issues_found.append(f"Very long segment: {duration:.1f}s for segment {i}")
    
    if issues_found:
        print(f"DEBUG: Found {len(issues_found)} timestamp issues:")
        for issue in issues_found:
            print(f"  - {issue}")
        
        # If we have major issues, regenerate all timestamps based on text length
        print("DEBUG: Regenerating all timestamps based on text length")
        return regenerate_timestamps_from_text(segments)
    
    return segments


def regenerate_timestamps_from_text(segments: List[TranscriptSegment]) -> List[TranscriptSegment]:
    """Regenerate timestamps based on text length and speaking rate."""
    
    print("DEBUG: Regenerating timestamps from text analysis")
    
    # Average speaking rate: ~150 words per minute = 2.5 words per second
    words_per_second = 2.5
    
    current_time = 0.0
    new_segments = []
    
    for i, segment in enumerate(segments):
        word_count = len(segment.text.split())
        duration = max(1.0, word_count / words_per_second)  # Minimum 1 second per segment
        
        new_segment = TranscriptSegment(
            start=current_time,
            end=current_time + duration,
            text=segment.text,
            speaker_tag=segment.speaker_tag,
            confidence=segment.confidence
        )
        
        new_segments.append(new_segment)
        current_time += duration + 0.5  # Add 0.5 second pause between segments
        
        print(f"DEBUG: Regenerated segment {i}: {new_segment.start:.1f}s - {new_segment.end:.1f}s")
    
    return new_segments


def add_estimated_timestamps(segments: List[TranscriptSegment]) -> List[TranscriptSegment]:
    """Add estimated timestamps to segments that have 0 timestamps."""
    
    if not segments:
        return segments
    
    # Check if all segments have 0 timestamps
    all_zero = all(seg.start == 0.0 and seg.end == 0.0 for seg in segments)
    
    if all_zero:
        print("DEBUG: All timestamps are 0, adding estimated timestamps")
        
        # Estimate based on text length and average speaking rate
        # Average speaking rate: ~150 words per minute = 2.5 words per second
        words_per_second = 2.5
        
        current_time = 0.0
        for i, segment in enumerate(segments):
            word_count = len(segment.text.split())
            duration = max(1.0, word_count / words_per_second)  # Minimum 1 second per segment
            
            segments[i] = TranscriptSegment(
                start=current_time,
                end=current_time + duration,
                text=segment.text,
                speaker_tag=segment.speaker_tag,
                confidence=segment.confidence
            )
            
            current_time += duration + 0.5  # Add 0.5 second pause between segments
            print(f"DEBUG: Estimated segment {i}: {segments[i].start:.1f}s - {segments[i].end:.1f}s")
    
    return segments

# Mock transcription function for testing without Riva
async def mock_transcribe_audio_file(
    file_path: Path,
    transcript_id: str,
    filename: str,
    settings: Settings
) -> Transcript:
    """Mock transcription for testing purposes."""
    
    # Simulate processing time
    import asyncio
    await asyncio.sleep(2)
    
    # Create mock transcript segments
    segments = [
        TranscriptSegment(
            start=0.0,
            end=15.0,
            text="Good morning, how are you feeling today?",
            speaker_tag=1,  # Doctor
            confidence=0.95
        ),
        TranscriptSegment(
            start=15.5,
            end=32.0,
            text="I've been having some chest pain and shortness of breath for the past few days.",
            speaker_tag=2,  # Patient
            confidence=0.92
        ),
        TranscriptSegment(
            start=33.0,
            end=48.0,
            text="Can you describe the chest pain? Is it sharp, dull, or crushing?",
            speaker_tag=1,  # Doctor
            confidence=0.97
        ),
        TranscriptSegment(
            start=49.0,
            end=65.0,
            text="It's more of a dull ache, and it gets worse when I walk up stairs.",
            speaker_tag=2,  # Patient
            confidence=0.94
        )
    ]
    
    # Create transcript
    transcript = Transcript(
        id=transcript_id,
        segments=segments,
        language="en-US",
        duration=65.0,
        filename=filename,
        created_at=datetime.now()
    )
    
    # Detect speaker roles
    transcript.speaker_roles = await detect_speaker_roles(transcript, settings)
    
    return transcript
