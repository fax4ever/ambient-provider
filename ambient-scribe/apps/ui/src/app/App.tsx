/*
 * SPDX-FileCopyrightText: Copyright (c) 2024-2025 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useRef } from 'react'
import { AudioDropzone } from '@/components/AudioDropzone'
import { TemplatePicker } from '@/components/TemplatePicker'
import { NoteEditor, NoteEditorRef } from '@/components/NoteEditor'
import { TracePanel } from '@/components/TracePanel'
import { TranscriptViewer } from '@/components/TranscriptViewer'
import { NotesList } from '@/components/NotesList'
import { Toaster } from '@/components/Toaster'
import { AudioPlayer, AudioPlayerRef } from '@/components/AudioPlayer'
import AmbientScribeAPI from '@/lib/api'
import { Transcript, TraceEvent, TemplateInfo, NoteResponse } from '@/lib/schema'
import { Health, Microphone, FolderOpen } from '@nv-brand-assets/react-icons-inline'
import { AppBar, Button, Text, ThemeProvider } from '@kui/react'
import { Volume2, FileText } from 'lucide-react'

function App() {
  // Configuration - toggle between streaming and offline transcription
  // Read from environment variable, default to true if not set
  const useStreaming = import.meta.env.VITE_USE_STREAMING !== 'false'
  
  // State management
  const [transcript, setTranscript] = useState<Transcript | null>(null)
  const [currentPartial, setCurrentPartial] = useState<{text: string, speaker: string, speaker_tag: number} | null>(null)
  const [note, setNoteInternal] = useState<string>('')
  
  // Wrapper to log all setNote calls
  const setNote = (value: string | ((prev: string) => string)) => {
    if (typeof value === 'function') {
      setNoteInternal(prev => {
        const result = value(prev)
        console.log('[App] setNote functional call - sections:', (result.match(/^## .+$/gm) || []).length)
        return result
      })
    } else {
      console.log('[App] setNote direct call - sections:', (value.match(/^## .+$/gm) || []).length)
      setNoteInternal(value)
    }
  }
  const [traces, setTraces] = useState<TraceEvent[]>([])
  const [selectedTemplate, setSelectedTemplate] = useState<string>('soap_default')
  const [templates, setTemplates] = useState<TemplateInfo[]>([])
  const [templateDefaults, setTemplateDefaults] = useState<string[]>([]) // Store current template's default messages
  const [isTranscribing, setIsTranscribing] = useState(false)
  const [isGenerating, setIsGenerating] = useState(false)
  const [noteState, setNoteState] = useState<'empty' | 'template' | 'generating' | 'complete'>('empty')
  
  // Session management
  const [currentNoteId, setCurrentNoteId] = useState<string | null>(null)
  const [generatedNotes, setGeneratedNotes] = useState<Set<string>>(new Set()) // Track which transcript+template combos have been generated
  const [lockedTemplates, setLockedTemplates] = useState<Set<string>>(new Set()) // Track which templates are locked for current transcript
  const [refreshNotesList, setRefreshNotesList] = useState<(() => void) | null>(null)
  const [notesRefreshTrigger, setNotesRefreshTrigger] = useState(0) // Direct trigger for notes refresh
  
  // Audio player ref for seeking functionality
  const audioPlayerRef = useRef<AudioPlayerRef>(null)
  const noteEditorRef = useRef<NoteEditorRef>(null)

  // Load templates on mount
  useEffect(() => {
    loadTemplates()
    loadExistingNotes()
  }, [])

  // Debug transcript changes
  useEffect(() => {
    console.log('[App] Transcript changed:', {
      id: transcript?.id,
      filename: transcript?.filename,
      segments: transcript?.segments?.length || 0,
      audio_url: transcript?.audio_url,
      hasAudioUrl: !!transcript?.audio_url
    })
  }, [transcript])

  const loadTemplates = async () => {
    try {
      const templateList = await AmbientScribeAPI.listTemplates()
      setTemplates(templateList)
    } catch (error) {
      console.error('Failed to load templates:', error)
    }
  }

  const loadExistingNotes = async () => {
    try {
      const notes = await AmbientScribeAPI.listNotes()
      const generated = new Set<string>()
      notes.forEach(note => {
        if (note.transcript_id) {
          generated.add(`${note.transcript_id}_${note.template_used}`)
        }
      })
      setGeneratedNotes(generated)
    } catch (error) {
      console.error('Failed to load existing notes:', error)
    }
  }

  // Helper functions for session management
  const createNewSession = async () => {
    console.log('[App] Creating new session - clearing everything and loading fresh template')
    
    // Clear all session data
    setTranscript(null)
    setTraces([])
    setNoteState('empty')
    setCurrentNoteId(null)
    setLockedTemplates(new Set())
    
    // Always load a fresh template when creating a new session
    try {
      if (selectedTemplate && templates.length > 0) {
        const preview = await AmbientScribeAPI.previewTemplate(selectedTemplate)
        if (preview?.rendered_content && preview.rendered_content.trim().length > 0) {
          console.log('[App] Fresh template loaded for new session')
          setNote(preview.rendered_content)
          setNoteState('template')
          return
        }
      }
      
      // Fallback: build a simple skeleton from template sections if available
      const info = templates.find(t => t.name === selectedTemplate)
      if (info && info.sections) {
        const templateNote = (info.sections || [])
          .map(s => `## ${s.charAt(0).toUpperCase() + s.slice(1)}\n\n*This section will be populated when you generate a note from your audio transcript.*\n`)
          .join('\n')
        console.log('[App] Fallback template loaded for new session')
        setNote(templateNote)
        setNoteState('template')
      } else {
        // If no template available, clear the note
        setNote('')
      }
    } catch (error) {
      console.error('Failed to load template for new session:', error)
      setNote('')
    }
  }

  const loadNoteSession = (noteResponse: NoteResponse, transcriptData: Transcript) => {
    setTranscript(transcriptData)
    setNote(noteResponse.note_markdown)
    setTraces(noteResponse.trace_events)
    setNoteState('complete')
    setCurrentNoteId(noteResponse.id || `${transcriptData.id}_${noteResponse.template_used}`)
    setSelectedTemplate(noteResponse.template_used)
    
    // Lock this template for this transcript since it's already generated
    setLockedTemplates(new Set([noteResponse.template_used]))
  }

  const getCurrentSessionKey = (): string | null => {
    return transcript ? `${transcript.id}_${selectedTemplate}` : null
  }

  const isCurrentSessionGenerated = (): boolean => {
    const sessionKey = getCurrentSessionKey()
    return sessionKey ? generatedNotes.has(sessionKey) : false
  }

  const isTemplateLockedForCurrentTranscript = (templateName: string): boolean => {
    return transcript ? lockedTemplates.has(templateName) : false
  }

  const handleNoteDeleted = async (deletedNoteId: string) => {
    // If the deleted note was the currently viewed note, clear the session
    if (currentNoteId === deletedNoteId) {
      await createNewSession()
    }
    
    // Remove from generated notes set
    const sessionKey = `${deletedNoteId.split('_')[0]}_${deletedNoteId.split('_').slice(1).join('_')}`
    setGeneratedNotes(prev => {
      const newSet = new Set(prev)
      newSet.delete(sessionKey)
      return newSet
    })
  }

  // Load initial template only once when app starts - NO MORE PREFILL OVERWRITING!
  useEffect(() => {
    const loadInitialTemplate = async () => {
      // Only load template if note is completely empty
      if (note.trim() === '') {
        console.log('🚨 [App] Loading initial template (one time only)')
        try {
          if (selectedTemplate) {
            const preview = await AmbientScribeAPI.previewTemplate(selectedTemplate)
            if (preview?.rendered_content && preview.rendered_content.trim().length > 0) {
              setNote(preview.rendered_content)
              setNoteState('template')
              return
            }
          }
          
          // Fallback: build a simple skeleton from template sections if available
          const info = templates.find(t => t.name === selectedTemplate)
          if (info && info.sections) {
            const templateNote = (info.sections || [])
              .map(s => `## ${s.charAt(0).toUpperCase() + s.slice(1)}\n\n*This section will be populated when you generate a note from your audio transcript.*\n`)
              .join('\n')
            setNote(templateNote)
            setNoteState('template')
          }
        } catch (error) {
          console.error('Failed to load initial template:', error)
        }
      } else {
        console.log('🚨 [App] Template load skipped - user has content:', note.length, 'characters')
      }
    }
    
    // Only run when templates are loaded and we have a selected template
    if (templates.length > 0 && selectedTemplate) {
      loadInitialTemplate()
    }
  }, [templates]) // Only depend on templates loading, not selectedTemplate

  // Load template defaults when template changes
  useEffect(() => {
    const loadTemplateDefaults = async () => {
      if (selectedTemplate) {
        try {
          const defaults = await AmbientScribeAPI.getTemplateDefaults(selectedTemplate)
          setTemplateDefaults(defaults)
          console.log(`[App] Loaded ${defaults.length} default messages for template '${selectedTemplate}'`)
        } catch (error) {
          console.error('Failed to load template defaults:', error)
          setTemplateDefaults([]) // Fallback to empty array
        }
      }
    }
    
    loadTemplateDefaults()
  }, [selectedTemplate])

  // Handle template changes - ask user if they want to switch
  useEffect(() => {
    const handleTemplateChange = async () => {
      // Skip if no templates loaded or no template selected
      if (templates.length === 0 || !selectedTemplate) return
      
      // Skip initial load (handled above)
      if (note.trim() === '') return
      
      // CRITICAL: Don't change templates during note generation!
      if (isGenerating) {
        console.log('[App] Template change blocked - note generation in progress')
        return
      }
      
      // CRITICAL: Don't change templates if we have a completed note with generated content!
      if (noteState === 'complete') {
        console.log('[App] Template change blocked - note is completed with generated content')
        return
      }
      
      // Check if user has meaningful content
      const hasUserContent = note.trim() && 
        (note.length > 300 || 
         /test|Test|[a-zA-Z]{6,}/.test(note.replace(/## \w+/g, '').replace(/No \w+ (information|findings|provided|discussed)/g, '').replace(/documented in the transcript/g, '').replace(/\*This section will be populated[^*]*\*/g, '')))
      
      // Only allow template changes if it's just template content (no user content and not completed)
      if (hasUserContent && noteState !== 'template') {
        console.log('[App] Template change blocked - user has content and note is not in template state')
        return
      }
      
      console.log('🚨 [App] Switching to new template:', selectedTemplate)
      
      try {
        const preview = await AmbientScribeAPI.previewTemplate(selectedTemplate)
        if (preview?.rendered_content && preview.rendered_content.trim().length > 0) {
          if (hasUserContent) {
            // Try to preserve user content by merging with new template
            // For now, just switch to new template - user confirmed they want this
            console.log('🚨 [App] Switching template with user content present')
          }
          setNote(preview.rendered_content)
          setNoteState('template')
        } else {
          // Fallback to section-based template
          const info = templates.find(t => t.name === selectedTemplate)
          if (info && info.sections) {
            const templateNote = (info.sections || [])
              .map(s => `## ${s.charAt(0).toUpperCase() + s.slice(1)}\n\n*This section will be populated when you generate a note from your audio transcript.*\n`)
              .join('\n')
            setNote(templateNote)
            setNoteState('template')
          }
        }
      } catch (error) {
        console.error('Failed to switch template:', error)
      }
    }
    
    handleTemplateChange()
  }, [selectedTemplate, isGenerating]) // React to template changes and generation status

  // Helper to update content under a section header while preserving user additions
  const updateSectionContent = (markdown: string, sectionKey: string, newContent: string) => {
    console.log(`[App] updateSectionContent: ${sectionKey}`)
    
    const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const toTitle = (s: string) => s
      .replace(/_/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/\b\w/g, (c) => c.toUpperCase())

    // Create multiple title variations to match different formats
    const candidateTitles = [
      toTitle(sectionKey),
      toTitle(sectionKey).replace('And Plan', 'and Plan'), // minor casing variation
      sectionKey.replace(/_/g, ' '), // keep original casing
      sectionKey.charAt(0).toUpperCase() + sectionKey.slice(1).replace(/_/g, ' '), // simple title case
    ]

    let updated = markdown
    for (const title of candidateTitles) {
      const headerPattern = new RegExp(`^(#{2,6})\\s+${escapeRegex(title)}\\s*$`, 'mi')
      const match = headerPattern.exec(updated)
      
      if (!match || match.index === undefined) {
        continue
      }
      
      console.log(`[App] Found section: ${title}`)

      const headerEnd = match.index + match[0].length
      const afterHeader = updated.slice(headerEnd)
      const nextHeaderMatch = /^(#{1,6})\s+/m.exec(afterHeader)
      const contentStart = headerEnd
      const contentEnd = nextHeaderMatch ? headerEnd + nextHeaderMatch.index : updated.length

      const before = updated.slice(0, contentStart)
      const after = updated.slice(contentEnd)
      const currentSectionContent = updated.slice(contentStart, contentEnd).trim()
      // Check if current section has only placeholder text or user additions
      const createPlaceholderPatterns = (templateDefaults: string[]) => {
        const patterns = [
          // Generic template placeholders
          /\*This section will be populated[^*]*\*/g,
          /No \w+ (information|findings|provided|discussed)[^.]*\./g,
          /documented in the transcript[^.]*\./g,
        ]
        
        // Add patterns for each template default message
        templateDefaults.forEach(defaultMsg => {
          // Escape special regex characters and create pattern
          const escapedMsg = defaultMsg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          patterns.push(new RegExp(escapedMsg, 'gi'))
        })
        
        // Add some common fallback patterns
        const commonPatterns = [
          /in transcript[^.]*\./gi,
          /not documented[^.]*\./gi,
          /not mentioned[^.]*\./gi,
          /not specified[^.]*\./gi,
          /not obtained[^.]*\./gi,
          /not performed[^.]*\./gi
        ]
        
        return [...patterns, ...commonPatterns]
      }
      
      const placeholderPatterns = createPlaceholderPatterns(templateDefaults)
      
      let preservedUserContent = currentSectionContent
      
      // Remove placeholder text but preserve user content
      for (const pattern of placeholderPatterns) {
        if (pattern.test(preservedUserContent)) {
          preservedUserContent = preservedUserContent.replace(pattern, '').trim()
        }
      }
      
      // Clean up extra whitespace and newlines
      preservedUserContent = preservedUserContent.replace(/\n\s*\n\s*\n/g, '\n\n').trim()
      
      // Combine preserved user content with new LLM content
      let finalContent = ''
      if (preservedUserContent) {
        // User has added content - preserve it and add LLM content
        finalContent = `${preservedUserContent}\n\n${newContent.trim()}`
      } else {
        // No user content - just use LLM content
        finalContent = newContent.trim()
      }
      
      const replacement = `\n${finalContent}\n`
      const result = `${before}${replacement}${after}`
      console.log(`[App] Section ${title} updated successfully`)
      
      // Verify that we haven't lost any sections
      const originalSections = (markdown.match(/^## /gm) || []).length
      const finalSections = (result.match(/^## /gm) || []).length
      if (finalSections < originalSections) {
        console.error(`[App] ERROR - Lost sections! Original: ${originalSections}, Final: ${finalSections}`)
      }
      
      return result
    }

    // If header was not found, append a new section at the end
    console.log(`[App] No matching header found for "${sectionKey}", appending to end`)
    const fallbackTitle = toTitle(sectionKey)
    const separator = updated.endsWith('\n') ? '' : '\n\n'
    const result = `${updated}${separator}## ${fallbackTitle}\n${newContent.trim()}\n`
    return result
  }

  const handleAudioUpload = async (file: File) => {
    setIsTranscribing(true)
    setTranscript(null)
    setCurrentPartial(null) // Clear any partial results from previous transcription
    setCurrentNoteId(null) // Clear current note ID when uploading new audio
    // Don't clear the note completely - let the template remain visible during transcription
    setTraces([])
    setNoteState('template') // Ensure we're in template state during transcription
    setLockedTemplates(new Set()) // Clear any previous locks since we're starting fresh

    try {
      
      if (useStreaming) {
        // Use streaming transcription
        const eventSource = AmbientScribeAPI.createStreamingTranscriptionStream(file)
        
        eventSource.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data)
            
            switch (data.type) {
              case 'status':
                console.log('Transcription status:', data.message)
                break
                
              case 'partial':
                // Update current partial result
                setCurrentPartial({
                  text: data.text,
                  speaker: data.speaker,
                  speaker_tag: data.speaker_tag || 1
                })
                
                // Ensure we have a transcript object for the UI
                setTranscript(prev => {
                  if (!prev) {
                    return {
                      id: data.transcript_id || 'streaming',
                      segments: [],
                      language: 'en-US',
                      duration: 0,
                      filename: file.name,
                      created_at: new Date().toISOString(),
                      audio_url: undefined,
                      speaker_roles: {}
                    }
                  }
                  return prev
                })
                break
                
              case 'final_segment':
                // Clear partial result since we have a final segment
                setCurrentPartial(null)
                
                // Add final segment to transcript
                setTranscript(prev => {
                  if (!prev) {
                    return {
                      id: data.transcript_id || 'streaming',
                      segments: [data.segment],
                      language: 'en-US',
                      duration: data.segment.end || 0,
                      filename: file.name,
                      created_at: new Date().toISOString(),
                      audio_url: undefined,
                      speaker_roles: {}
                    }
                  }
                  
                  const newSegment = data.segment
                  const segments = [...prev.segments]
                  
                  // Check if the most recent segment is from the same speaker
                  const lastSegment = segments[segments.length - 1]
                  const isSameSpeaker = lastSegment && 
                    lastSegment.speaker_tag === newSegment.speaker_tag
                  
                  console.log(`[SPEAKER TRACKING] New segment from speaker ${newSegment.speaker_tag}, last segment from speaker ${lastSegment?.speaker_tag}, same speaker: ${isSameSpeaker}`)
                  
                  if (isSameSpeaker) {
                    // Append text to the existing segment instead of creating a new one
                    console.log(`[SPEAKER TRACKING] Appending text "${newSegment.text}" to existing segment`)
                    
                    segments[segments.length - 1] = {
                      ...lastSegment,
                      text: lastSegment.text + ' ' + newSegment.text,
                      end: newSegment.end, // Update end time to the latest
                      confidence: newSegment.confidence // Use latest confidence if available
                    }
                  } else {
                    // Different speaker or first segment, add as new segment
                    console.log(`[SPEAKER TRACKING] Adding new segment from speaker ${newSegment.speaker_tag}`)
                    segments.push(newSegment)
                  }
                  
                  return {
                    ...prev,
                    segments,
                    duration: Math.max(prev.duration || 0, newSegment.end || 0)
                  }
                })
                break
                
              case 'audio_url':
                // Update transcript with audio URL, create transcript object if it doesn't exist
                console.log('[App] Received audio_url event:', data.audio_url)
                setTranscript(prev => {
                  if (prev) {
                    console.log('[App] Updating existing transcript with audio_url:', data.audio_url)
                    return { ...prev, audio_url: data.audio_url }
                  }
                  // Create a new transcript object if one doesn't exist yet
                  console.log('[App] Creating new transcript with audio_url:', data.audio_url)
                  return {
                    id: data.transcript_id || 'streaming',
                    segments: [],
                    language: 'en-US',
                    duration: 0,
                    filename: file.name,
                    created_at: new Date().toISOString(),
                    audio_url: data.audio_url,
                    speaker_roles: {}
                  }
                })
                console.log('Audio URL received and set:', data.audio_url)
                break
                
              case 'complete':
                // Final transcript received
                console.log('[App] Complete event - received transcript:', data.transcript)
                console.log('[App] Complete event - transcript audio_url:', data.transcript?.audio_url)
                setTranscript(data.transcript)
                setCurrentPartial(null) // Clear any remaining partial
                eventSource.close()
                setIsTranscribing(false)
                console.log('Streaming transcription completed')
                break
                
              case 'error':
                console.error('Streaming transcription error:', data.error)
                eventSource.close()
                setIsTranscribing(false)
                throw new Error(data.error)
            }
          } catch (error) {
            console.error('Error parsing streaming data:', error)
            eventSource.close()
            setIsTranscribing(false)
          }
        }
        
        eventSource.onerror = (error) => {
          console.error('Streaming transcription connection error:', error)
          eventSource.close()
          setIsTranscribing(false)
          setNoteState('template') // Reset to template state on error
        }
        
        // Clean up event source on component unmount or when starting new transcription
        return () => {
          eventSource.close()
        }
      } else {
        // Fallback to regular transcription
        const newTranscript = await AmbientScribeAPI.transcribeFile(file)
        setTranscript(newTranscript)
        setIsTranscribing(false)
      }
    } catch (error: any) {
      console.error('Transcription failed:', error)
      // Log detailed error information for debugging
      if (error.response?.data) {
        console.error('Error details:', error.response.data)
      }
      setIsTranscribing(false)
      setNoteState('template') // Reset to template state on error
      // Error will be shown by toast
    }
  }

  const handleGenerateNote = async () => {
    if (!transcript) return

    // Check if this combination is already generated
    if (isCurrentSessionGenerated()) {
      console.log('Note already generated for this transcript and template')
      return
    }

    setIsGenerating(true)
    setTraces([])
    setNoteState('generating')
    
    // Lock the current template for this transcript
    setLockedTemplates(prev => new Set([...prev, selectedTemplate]))

    console.log('🚨 [App] Starting note generation - PRESERVING all user content')
    console.log('🚨 [App] Current note length:', note.length, 'characters')

    try {
      // Create stream for real-time updates
      const eventSource = AmbientScribeAPI.createNoteStream({
        transcript_id: transcript.id,
        template_name: selectedTemplate,
        include_traces: true,
      })

      eventSource.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data)
          console.log('🚨 [App] Note generation event received:', {
            type: data.type,
            section: data.section || 'N/A',
            hasContent: !!data.content,
            contentLength: data.content?.length || 0,
            eventData: data.type === 'section_complete' ? data : 'Not section_complete'
          })
          
          switch (data.type) {
            case 'trace':
              setTraces(prev => [...prev, {
                timestamp: data.timestamp,
                event_type: data.event,
                message: data.message,
                metadata: data.metadata || {}
              }])
              break
            
            case 'section_complete':
              console.log('🚨 [App] Section complete event received:', {
                section: data.section,
                contentLength: data.content?.length || 0,
                contentPreview: data.content?.substring(0, 100) || 'No content'
              })
              
              // CRITICAL FIX: Use functional update to ensure we get the latest note state
              setNote(currentNote => {
                console.log('[App] Section update:', data.section, 'sections before:', (currentNote?.match(/^## .+$/gm) || []).length)
                const updated = updateSectionContent(currentNote || '', data.section, data.content)
                console.log('[App] Section update complete - sections after:', (updated.match(/^## .+$/gm) || []).length)
                return updated
              })
              
              // Add a completion trace event for the UI
              setTraces(prev => [...prev, {
                timestamp: data.timestamp,
                event_type: 'section_complete',
                message: `${data.section.replace('_', ' ').charAt(0).toUpperCase() + data.section.replace('_', ' ').slice(1)} section completed`,
                metadata: {
                  section: data.section,
                  content: data.content
                }
              }])
              break
            
            case 'complete':
              console.log('🚨 [App] Note generation complete - PRESERVING all section updates with user content')
              // DON'T overwrite the note here - we've already built it section by section!
              // setNote(data.note_markdown) // ← This was destroying all our work!
              setNoteState('complete')
              
              // Mark this session as generated
              const sessionKey = getCurrentSessionKey()
              if (sessionKey) {
                setGeneratedNotes(prev => new Set([...prev, sessionKey]))
                setCurrentNoteId(sessionKey)
              }
              
              // Add a completion trace event for the UI
              setTraces(prev => [...prev, {
                timestamp: data.timestamp,
                event_type: 'complete',
                message: 'Note generation completed successfully',
                metadata: {
                  note_length: data.note_markdown?.length || 0
                }
              }])
              
              // Refresh the notes list to show the newly saved note
              console.log('App: Note generation completed, triggering notes refresh...')
              // Use direct trigger approach
              setNotesRefreshTrigger(prev => prev + 1)
              
              // Multiple backup refresh attempts
              if (refreshNotesList) {
                console.log('App: Also calling refreshNotesList callback')
                setTimeout(() => refreshNotesList(), 100)
                setTimeout(() => refreshNotesList(), 1000) // Second attempt after 1s
                setTimeout(() => refreshNotesList(), 2000) // Third attempt after 2s
              }
              
              // Additional direct trigger as backup
              setTimeout(() => {
                console.log('App: Backup trigger after 1 second')
                setNotesRefreshTrigger(prev => prev + 1)
              }, 1000)
              
              eventSource.close()
              setIsGenerating(false)
              break
            
            case 'error':
              console.error('Note generation error:', data.message)
              setNote(`# Generation Failed\n\n*There was an error generating your medical note:*\n\n**${data.message}**\n\n*Please try again. If the problem persists, check your audio quality and transcript.*`)
              setNoteState('empty')
              eventSource.close()
              setIsGenerating(false)
              break
          }
        } catch (error) {
          console.error('Failed to parse stream event:', error)
        }
      }

      eventSource.onerror = () => {
        eventSource.close()
        setIsGenerating(false)
        setNoteState('template') // Reset to template state on error
        
        // Fallback to regular API call
        handleGenerateNoteFallback()
      }

    } catch (error) {
      console.error('Failed to start streaming:', error)
      setIsGenerating(false)
      setNoteState('template') // Reset to template state on error
      
      // Fallback to regular API call
      handleGenerateNoteFallback()
    }
  }

  const handleGenerateNoteFallback = async () => {
    if (!transcript) return

    try {
      const response = await AmbientScribeAPI.buildNote({
        transcript_id: transcript.id,
        template_name: selectedTemplate,
        include_traces: true,
      })

      console.log('🚨 [App] Fallback generation complete - using section-based updates instead of overwrite')
      
      // Instead of overwriting, let's parse the response and update sections individually
      // This preserves user content in each section
      if (response.note_markdown && response.note_markdown.trim()) {
        // Parse the LLM response by sections and update each one
        const sections = response.note_markdown.split(/^## /gm).filter(s => s.trim())
        
        for (const section of sections) {
          const lines = section.split('\n')
          const sectionTitle = lines[0].replace(/^#+\s*/, '').trim()
          const sectionContent = lines.slice(1).join('\n').trim()
          
          if (sectionTitle && sectionContent) {
            console.log(`🚨 [App] Fallback updating section: ${sectionTitle}`)
            setNote(prev => updateSectionContent(prev || '', sectionTitle.toLowerCase().replace(/\s+/g, '_'), sectionContent))
          }
        }
      }
      
      setTraces(response.trace_events)
      setNoteState('complete')
      
      // Mark this session as generated
      const sessionKey = getCurrentSessionKey()
      if (sessionKey) {
        setGeneratedNotes(prev => new Set([...prev, sessionKey]))
        setCurrentNoteId(sessionKey)
      }
      
      // Refresh the notes list to show the newly saved note
      console.log('App: Fallback note generation completed, triggering notes refresh...')
      // Use direct trigger approach
      setNotesRefreshTrigger(prev => prev + 1)
      
      // Also try the callback approach as backup
      if (refreshNotesList) {
        console.log('App: Also calling refreshNotesList (fallback) callback')
        setTimeout(() => refreshNotesList(), 100)
      }
    } catch (error) {
      console.error('Note generation failed:', error)
      setNote(`# Generation Failed\n\n*There was an error generating your medical note:*\n\n**${error}**\n\n*Please try again. If the problem persists, check your audio quality and transcript.*`)
      setNoteState('template') // Reset to template state on error
    }
  }

  return (
    <ThemeProvider>
      <div className="h-screen bg-surface-base text-primary flex flex-col">
      {/* Header */}
      <AppBar
        slotLeft={
          <div className="flex items-center space-x-3">
            <Health className="h-7 w-7 text-brand" />
            <div className="flex flex-col leading-tight">
              <Text kind="title/md" className="text-primary font-semibold leading-tight" style={{ lineHeight: '1.1' }}>Ambient Scribe</Text>
              <Text kind="label/regular/xs" className="text-secondary leading-tight" style={{ lineHeight: '1.1' }}>AI-Powered Medical Documentation</Text>
            </div>
          </div>
        }
        slotRight={
          <div className="min-w-[300px]">
            <TemplatePicker
              templates={templates}
              selectedTemplate={selectedTemplate}
              onTemplateChange={(templateName) => {
                // Completely prevent template changes during transcription or generation
                if (isTranscribing || isGenerating) {
                  console.log('Template change blocked: transcription or generation in progress')
                  return
                }
                
                // Don't allow changing template if it's locked for current transcript
                if (isTemplateLockedForCurrentTranscript(templateName) || isTemplateLockedForCurrentTranscript(selectedTemplate)) {
                  console.log('Template change blocked: template is locked for current transcript')
                  return
                }
                
                console.log('Template changed from', selectedTemplate, 'to', templateName)
                setSelectedTemplate(templateName)
                // If we're not generating, reset to template state to show new template
                if (!isGenerating) {
                  setNoteState('template')
                  setCurrentNoteId(null) // Clear current note when switching templates
                }
              }}
              compact={true}
              disabled={isTranscribing || isGenerating || noteState === 'complete' || Boolean(transcript && lockedTemplates.size > 0)}
              isTranscribing={isTranscribing}
            />
          </div>
        }
      />

      {/* Main Layout */}
      <div className="flex-1 flex overflow-hidden">
        
        {/* Left Sidebar - Audio Toolbar */}
        <aside className="w-80 bg-surface-raised border-r border-base flex-shrink-0">
          <div className="h-full flex flex-col">
            {/* Notes List */}
            <div className="border-b border-base">
              <NotesList
                currentNoteId={currentNoteId || undefined}
                onNoteSelect={loadNoteSession}
                onNewNote={createNewSession}
                onRefreshReady={setRefreshNotesList}
                onNoteDeleted={handleNoteDeleted}
                refreshTrigger={notesRefreshTrigger}
              />
            </div>
            
            {/* Audio Section Header */}
            <div className="p-4 border-b border-base">
              <div className="flex items-center space-x-2 mb-3">
                <Volume2 className="h-5 w-5 text-brand" />
                <Text kind="title/sm" className="text-primary">Current Audio</Text>
              </div>
              
              {/* Audio Upload */}
              <AudioDropzone 
                onFileUpload={handleAudioUpload}
                isUploading={isTranscribing}
                compact={true}
                disabled={currentNoteId !== null || isGenerating || isTranscribing}
              />
            </div>
            
            {/* Audio File List */}
            <div className="flex-1 p-4">
              {transcript ? (
                <div className="space-y-2">
                  <div className="flex items-center space-x-2 text-sm text-secondary mb-3">
                    <FolderOpen className="h-4 w-4" />
                    <span>Current Audio</span>
                  </div>
                  <div className="bg-accent-blue-subtle border border-accent-blue rounded-lg p-3">
                    <div className="flex items-start space-x-2">
                      <Microphone className="h-4 w-4 text-accent-blue mt-0.5" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-primary truncate">
                          {transcript.filename || 'Audio File'}
                        </p>
                        <p className="text-xs text-secondary mt-1">
                          {transcript.duration ? `${Math.round(transcript.duration)}s` : ''} • 
                          {transcript.segments.length} segments
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="text-center text-secondary mt-8">
                  <Microphone className="h-8 w-8 mx-auto mb-2 text-subtle" />
                  <p className="text-sm">No audio uploaded</p>
                  <p className="text-xs text-subtle">Upload an audio file to get started</p>
                </div>
              )}
              
              {/* Generate Button */}
              <div className="mt-6">
                <Button
                  onClick={handleGenerateNote}
                  disabled={!transcript || isTranscribing || isGenerating || isCurrentSessionGenerated()}
                  kind="primary"
                  color="brand"
                  size="large"
                  className="w-full"
                >
                  {isTranscribing ? 'Transcribing Audio...' :
                   isGenerating ? 'Generating Note...' : 
                   isCurrentSessionGenerated() ? 'Note Already Generated' :
                   'Generate Medical Note'}
                </Button>
                
                {isCurrentSessionGenerated() && (
                  <p className="mt-2 text-xs text-secondary text-center">
                    Upload a new audio file to generate another note
                  </p>
                )}
              </div>
            </div>
          </div>
        </aside>

        {/* Center - Note Editor */}
        <main className="flex-1 flex flex-col bg-surface-base shadow-sm">
          <div className="flex items-center justify-between p-4 border-b border-base bg-surface-raised">
            <div className="flex items-center space-x-3">
              <FileText className="h-5 w-5 text-brand" />
              <div>
                <Text kind="title/sm" className="text-primary">Medical Note</Text>
                {/* Status indicator */}
                <div className="flex items-center space-x-2 mt-1">
                  {noteState === 'empty' && (
                    <span className="text-xs text-secondary flex items-center space-x-1">
                      <span className="w-2 h-2 bg-subtle rounded-full"></span>
                      <span>No audio uploaded</span>
                    </span>
                  )}
                  {noteState === 'template' && !isTranscribing && !transcript && (
                    <span className="text-xs text-accent-blue flex items-center space-x-1">
                      <span className="w-2 h-2 bg-accent-blue rounded-full"></span>
                      <span>Ready to transcribe</span>
                    </span>
                  )}
                  {noteState === 'template' && !isTranscribing && transcript && (
                    <span className="text-xs text-accent-green flex items-center space-x-1">
                      <span className="w-2 h-2 bg-accent-green rounded-full"></span>
                      <span>Ready to generate</span>
                    </span>
                  )}
                  {isTranscribing && (
                    <span className="text-xs text-accent-yellow flex items-center space-x-1">
                      <span className="w-2 h-2 bg-accent-yellow rounded-full animate-pulse"></span>
                      <span>Transcribing audio...</span>
                    </span>
                  )}
                  {noteState === 'generating' && (
                    <span className="text-xs text-accent-green flex items-center space-x-1">
                      <span className="w-2 h-2 bg-accent-green rounded-full animate-pulse"></span>
                      <span>Generating note...</span>
                    </span>
                  )}
                  {noteState === 'complete' && (
                    <span className="text-xs text-brand flex items-center space-x-1">
                      <span className="w-2 h-2 bg-brand rounded-full"></span>
                      <span>Note completed</span>
                    </span>
                  )}
                </div>
              </div>
            </div>
            
            {note && (
              <Button
                onClick={async () => {
                  try {
                    // Try modern clipboard API first
                    if (navigator.clipboard && window.isSecureContext) {
                      await navigator.clipboard.writeText(note)
                      console.log('Note copied to clipboard using modern API')
                    } else {
                      // Fallback for older browsers or insecure contexts (like Brev)
                      const textArea = document.createElement('textarea')
                      textArea.value = note
                      textArea.style.position = 'fixed'
                      textArea.style.left = '-999999px'
                      textArea.style.top = '-999999px'
                      document.body.appendChild(textArea)
                      textArea.focus()
                      textArea.select()
                      
                      try {
                        document.execCommand('copy')
                        console.log('Note copied to clipboard using fallback method')
                      } catch (err) {
                        console.error('Fallback copy failed:', err)
                        // Final fallback - select all text for manual copy
                        textArea.select()
                        alert('Please press Ctrl+C (or Cmd+C on Mac) to copy the selected text')
                      }
                      
                      document.body.removeChild(textArea)
                    }
                  } catch (err) {
                    console.error('Copy to clipboard failed:', err)
                    // Show user-friendly error message
                    alert('Copy failed. Please select the text manually and use Ctrl+C (or Cmd+C on Mac)')
                  }
                }}
                kind="tertiary"
                size="small"
              >
                Copy Note
              </Button>
            )}
          </div>
          
          <div className="flex-1 min-h-0 flex flex-col">
            <NoteEditor
              ref={noteEditorRef}
              value={note}
              onChange={setNote}
              transcript={transcript || undefined}
              isReadOnly={isGenerating}
            />
          </div>
        </main>

        {/* Right Sidebar - Audio Player, Transcript and Traces */}
        <aside className="w-96 bg-surface-sunken border-l border-base flex-shrink-0">
          <div className="h-full flex flex-col gap-4 p-4">
            {/* Audio Player - Always visible with fixed height */}
            <div className="h-40 flex-shrink-0">
              <AudioPlayer 
                ref={audioPlayerRef}
                audioUrl={transcript?.audio_url || null}
                onTimeUpdate={(currentTime, duration) => {
                  // Could implement highlighting current segment based on audio time
                  console.log('Audio time update:', currentTime, duration)
                }}
              />
            </div>
            
            {/* Transcript Viewer - Fixed proportion */}
            <div className="flex-[3] min-h-0">
              <TranscriptViewer 
                transcript={transcript}
                isLoading={isTranscribing}
                currentPartial={useStreaming ? currentPartial : null}
                onSeekToTime={(seconds) => {
                  audioPlayerRef.current?.seekToTime(seconds)
                }}
                onInsertTimestamp={(timestamp) => {
                  noteEditorRef.current?.insertTimestamp(timestamp)
                }}
              />
            </div>
            
            {/* Trace Panel - Fixed proportion */}
            <div className="flex-[2] min-h-0">
              <TracePanel 
                traces={traces}
                isGenerating={isGenerating}
              />
            </div>
          </div>
        </aside>
      </div>

      {/* Toast Notifications */}
      <Toaster />
      </div>
    </ThemeProvider>
  )
}

export default App
