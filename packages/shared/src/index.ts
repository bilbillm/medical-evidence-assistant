export type SessionStatus =
  | 'WAITING_FIRST_INPUT'
  | 'PARSING_INPUT'
  | 'ASKING_FOLLOWUP'
  | 'WAITING_USER_ANSWER'
  | 'READY_FOR_PATIENT_VIEW'
  | 'READY_FOR_DOCTOR_PACKAGE'
  | 'COMPLETED'
  | 'ERROR_NEEDS_USER_ACTION';

export type SourceType = 'image' | 'pdf' | 'text' | 'audio_transcript' | 'patient_text' | 'document';

export interface SourceDocumentDto {
  id: string;
  sourceType: SourceType;
  displayName: string;
  thumbnailUrl?: string;
  extractedText?: string;
  createdAt: string;
}

export interface PatientFactDto {
  id: string;
  label: string;
  content: string;
  createdAt: string;
}

export interface MessageAttachmentDto {
  documentId?: string;
  fileName: string;
  sourceType: SourceType;
  thumbnailUrl?: string;
}

export interface ChatMessageDto {
  id: string;
  role: 'assistant' | 'user';
  content: string;
  createdAt: string;
  kind?: 'message' | 'patient_view' | 'doctor_package';
  attachments?: MessageAttachmentDto[];
}

export interface ResultCardDto {
  title: string;
  sections: Array<{
    title: string;
    content: string[];
  }>;
}

export interface PackageDownloadDto {
  packageId: string;
  packageType: 'patient' | 'doctor';
  fileName: string;
  downloadUrl: string;
}

export interface SessionDto {
  id: string;
  status: SessionStatus;
  messages: ChatMessageDto[];
  documents: SourceDocumentDto[];
  facts: PatientFactDto[];
  factSummaries: PatientFactDto[];
  patientView?: ResultCardDto;
  doctorPackage?: ResultCardDto;
  packages: PackageDownloadDto[];
}

export interface CreateSessionResponse {
  session: SessionDto;
}

export interface SubmitMessageRequest {
  content: string;
  attachmentDocumentIds?: string[];
}

export interface SubmitMessageResponse {
  session: SessionDto;
  assistantMessage?: ChatMessageDto;
  patientView?: ResultCardDto;
}

export interface UploadFileResponse {
  session: SessionDto;
  document: SourceDocumentDto;
  documents?: SourceDocumentDto[];
  assistantMessage?: ChatMessageDto;
}

export interface AudioTranscriptResponse {
  transcript: string;
}
