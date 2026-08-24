import { createFileRoute } from '@tanstack/react-router'
import { VoiceCallApp } from '../features/voiceCall/VoiceCallApp'

export const Route = createFileRoute('/')({ component: VoiceCallApp })
