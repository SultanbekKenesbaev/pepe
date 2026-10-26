export type Role = 'SUPER_ADMIN' | 'ADMIN' | 'TEACHER' | 'DIRECTOR' | 'TECHNICIAN' | 'STUDENT' | 'PARENT';
export type InstitutionType = 'SCHOOL' | 'UNIVERSITY' | 'KINDERGARTEN';
export interface User { id: string; name: string; email: string; role: Role; institutionId: string | null; active: boolean; mfaEnabled?: boolean; groupIds?: string[]; studentId?: string; childIds?: string[] }
export interface Institution { id: string; name: string; type: InstitutionType; language: string; settings: { voice?: string; allowExternalAI?: boolean; retentionDays?: number; modules?: string[]; timezone?: string }; createdAt?: string }
export type EntityKind = 'groups' | 'students' | 'subjects' | 'lessons' | 'materials' | 'schedule' | 'devices' | 'departments' | 'assignments' | 'programs' | 'rooms';
export interface BaseEntity { id: string; institutionId: string; name: string; createdAt?: string; updatedAt?: string }
export interface Group extends BaseEntity { level?: string; teacherId?: string; teacherIds?: string[]; departmentId?: string }
export interface Student extends BaseEntity { groupId: string }
export interface Subject extends BaseEntity { description?: string }
export interface Section { id: string; title: string; content: string; materialIds: string[] }
export interface QuizQuestion { id: string; question: string; options: string[]; correctIndex: number; explanation?: string }
export interface Lesson extends BaseEntity { subjectId: string; groupId?: string; programId?: string; description?: string; duration: number; language: string; sections: Section[]; quiz: QuizQuestion[]; approved: boolean; cinemaId?: string; videoMode?: GeneratedLessonVideoMode }
export interface Material extends BaseEntity { subjectId?: string; topic?: string; language: string; ageLevel?: string; type: 'text' | 'image' | 'pdf' | 'video' | 'link' | 'presentation'; content?: string; url?: string; fileId?: string; source?: string; license?: string; approved: boolean }
export interface ScheduleItem extends BaseEntity { lessonId: string; groupId: string; teacherId: string; startsAt: string; room?: string; roomId?: string; allDay?: boolean; durationMinutes?: number; revision?: number; cancelled?: boolean; cancelledAt?: string; cancelledBy?: string; date?: string; startTime?: string }
export interface Device extends BaseEntity { room: string; roomId?: string; type: 'camera' | 'microphone' | 'speaker' | 'panel'; status: 'unknown' | 'online' | 'offline'; model?: string; lastCheckedAt?: string }
export interface Assignment extends BaseEntity { groupId: string; lessonId?: string; instructions: string; dueAt?: string }
export interface Department extends BaseEntity { parentId?: string }
export interface Program extends BaseEntity { description?: string; subjectIds: string[]; groupIds: string[]; language: string; ageLevel?: string }
export interface Room extends BaseEntity { capacity?: number; description?: string }
export type Entity = Group | Student | Subject | Lesson | Material | ScheduleItem | Device | Assignment | Department | Program | Room;
export type LessonState = 'READY' | 'CHECKING_ATTENDANCE' | 'TEACHING' | 'LISTENING_FOR_QUESTION' | 'ANSWERING' | 'CHECKING_FOLLOW_UP' | 'KNOWLEDGE_CHECK' | 'PAUSED_BY_TEACHER' | 'RECOVERY' | 'COMPLETED';
export type SessionAction = 'start' | 'confirmAttendance' | 'pause' | 'resume' | 'next' | 'listen' | 'cancelQuestion' | 'followUpDone' | 'knowledgeCheck' | 'recover' | 'complete' | 'checkpoint';
export interface Attendance { studentId: string; status: 'present' | 'absent' | 'late' | 'excused'; method: 'manual'; updatedBy?: string; updatedAt?: string }
export interface QuizResult { questionId: string; selectedIndex: number; correct: boolean; studentId?: string }
export interface LessonSession { id: string; institutionId: string; lessonId: string; groupId: string; teacherId: string; state: LessonState; sectionIndex: number; position: number; revision: number; lesson: Lesson; features?: { attendance: boolean; quizzes: boolean }; attendance: Attendance[]; results: QuizResult[]; previousState?: LessonState; startedAt?: string; completedAt?: string; createdAt: string; updatedAt: string }
export interface QuestionAnswer { id: string; sessionId: string; question: string; answer: string; status: 'answered' | 'teacher_required' | 'failed'; mode: 'local' | 'provider'; sources: { title: string; id?: string }[]; createdAt: string }
export interface AuditEntry { id: string; institutionId: string | null; actorId: string; actorName?: string; action: string; targetId?: string; createdAt: string }
export interface Dashboard { institutions: number; groups: number; students: number; lessons: number; sessions: number; completedSessions: number; attendanceRate: number; recentSessions: LessonSession[]; recentAudit: AuditEntry[] }
export interface AIStatus { configured: boolean; mode: 'local' | 'provider'; model?: string; externalAllowed: boolean }
export interface Bootstrap { user: User; institutions: Institution[]; ai: AIStatus; csrfToken: string }
export const roleLabels: Record<Role,string> = { SUPER_ADMIN:'Суперадминистратор', ADMIN:'Администратор', TEACHER:'Преподаватель', DIRECTOR:'Руководитель', TECHNICIAN:'Техник', STUDENT:'Учащийся', PARENT:'Родитель' };
export const stateLabels: Record<LessonState,string> = { READY:'Готов к запуску', CHECKING_ATTENDANCE:'Посещаемость', TEACHING:'Объяснение материала', LISTENING_FOR_QUESTION:'Ожидание вопроса', ANSWERING:'Ответ на вопрос', CHECKING_FOLLOW_UP:'Есть ещё вопросы?', KNOWLEDGE_CHECK:'Проверка знаний', PAUSED_BY_TEACHER:'Пауза', RECOVERY:'Восстановление', COMPLETED:'Завершён' };

// University workspace. Legacy lesson types above remain only for stored history.
export interface SemesterFile { id: string; name: string; mime?: string; extractedCharacters?: number }
export interface SemesterTopic { id: string; title: string; content: string; order: number; documentName?: string }
export interface WeeklySlot { weekday: number; startTime: string; durationMinutes: number; roomId?: string }
export interface Semester { id: string; institutionId: string; teacherId: string; name: string; subjectId: string; groupIds: string[]; startDate: string; endDate: string; timezone?: string; files: SemesterFile[]; topics: SemesterTopic[]; schedule: WeeklySlot[]; status: 'draft' | 'ready'; createdAt: string; updatedAt: string }
export interface TeachingEvent { id: string; institutionId: string; semesterId?: string; lessonId?: string; subjectId: string; groupId: string; teacherId: string; roomId?: string; room?: string; date: string; startsAt: string; endsAt: string; topic: SemesterTopic; semesterName?: string; allDay?: boolean; cinemaId?: string; scheduleItemId?: string; scheduleRevision?: number }
export type UniversityAttendanceStatus = 'present' | 'late' | 'unconfirmed' | 'absent' | 'excused';
export interface UniversityAttendance { studentId: string; status: UniversityAttendanceStatus; method: 'camera' | 'manual'; firstSeenAt?: string; lastSeenAt?: string; similarity?: number; reviewed?: boolean; updatedBy?: string; updatedAt?: string }
export interface CameraMatch { studentId: string; similarity: number }
export interface AttendanceScan { id: string; sessionId: string; capturedAt: string; detectedFaces: number; matches: CameraMatch[]; unknownFaces: number; status: 'completed' | 'failed'; error?: string }
export interface TeachingSession { roster?: { studentId: string; name: string }[]; id: string; institutionId: string; eventId: string; event: TeachingEvent; teacherId: string; groupId: string; state: 'live' | 'paused' | 'completed'; startedAt: string; pausedAt?: string; pausedMs: number; completedAt?: string; scanOffsets: number[]; scans: AttendanceScan[]; attendance: UniversityAttendance[]; revision: number }
export interface FaceEnrollment { studentId: string; descriptor: number[]; modelVersion: string; photoFileId?: string; enrolledAt: string }
export interface UniversityData { date: string; semesters: Semester[]; events: TeachingEvent[]; sessions: TeachingSession[]; groups: Group[]; students: Student[]; subjects: Subject[]; rooms: Room[]; teachers: User[] }

// Teacher-owned source documents. Generation starts explicitly after upload and requires script review.
export interface LessonMaterialFile { id: string; name: string; mime: string; size: number; extractedCharacters: number; url: string }
export interface LessonMaterial { id: string; institutionId: string; teacherId: string; subjectId: string; title: string; status: 'stored'; files: LessonMaterialFile[]; extractedCharacters: number; createdAt: string; updatedAt: string }
export interface LessonMaterialDetail extends LessonMaterial { documents: { fileId: string; text: string }[] }
export interface AttendanceAnalyticsCounts {
  sessions: number; completedSessions: number; liveSessions: number; pausedSessions: number;
  present: number; late: number; absent: number; excused: number; unconfirmed: number; total: number;
  /** Present + late divided by confirmed accountable records (present + late + absent). */
  attendanceRate: number | null;
  /** All reviewed/identified records divided by all stored attendance records. */
  confirmationRate: number | null;
}
export interface AttendanceAnalytics {
  from: string; to: string; timezone: string;
  totals: AttendanceAnalyticsCounts;
  days: (AttendanceAnalyticsCounts & { date: string })[];
  groups: (AttendanceAnalyticsCounts & { groupId: string; name: string })[];
  sessions: TeachingSession[];
}

export type GeneratedLessonStatus = 'drafting' | 'draft' | 'generating' | 'language_review' | 'ready' | 'failed';
export type GeneratedLessonLanguage = 'ru' | 'kaa' | 'uz';
export type GeneratedLessonVideoMode = '2d' | '3d';
export interface GeneratedLessonCue { id: string; text: string; visualAction: string; start?: number; duration?: number; audioDuration?: number; audioUrl?: string; audioHash?: string }
export interface GeneratedLessonChapter {
  id: string; title: string; narration: string;
  scene: 'concept' | 'chart' | 'process' | 'comparison' | 'orbit' | 'custom';
  headline: string; formula?: string; labels: string[]; values: number[]; example?: string;
  palette: 'light' | 'dark'; start: number; duration: number; audioUrl?: string; audioDuration?: number;
  direction?: string; visualDirection?: string; cues?: GeneratedLessonCue[];
}
export interface LessonPublication { startsAt?: string; endsAt?: string; timezone: string }
export interface GeneratedLessonArtifact { videoUrl: string; duration: number; width: number; height: number; fps: number; sha256: string }
export interface GeneratedLessonVoiceProfile { backend?: 'google' | 'openrouter'; model: string; voice: string; language: GeneratedLessonLanguage; styleVersion: string }
export type GeneratedLessonPhase = 'queued' | 'alignment' | 'images' | 'authoring' | 'checking' | 'reviewing' | 'rendering' | 'validating' | 'downloading';
export interface GeneratedLessonWorkerProgress {
  phase: GeneratedLessonPhase; completed: number; total: number;
  stageStartedAt?: string; frames?: { completed: number; total: number };
}
export interface GeneratedLessonProgress {
  stage: 'planning' | 'script' | 'review' | 'voice' | 'visuals' | 'checking' | 'language_review' | 'ready' | 'failed';
  completed: number; total: number;
  /** Overall estimate from completed phases; only ready is 100%. */
  percent?: number; phase?: GeneratedLessonPhase; stageStartedAt?: string; elapsedSeconds?: number;
  estimatedRemainingSeconds?: { min: number; max: number };
  /** Actual encoded-frame checkpoints reported by the isolated renderer. */
  frames?: { completed: number; total: number };
}
export interface GeneratedLesson {
  id: string; institutionId: string; teacherId: string; subjectId: string; materialId?: string;
  title: string; summary: string; status: GeneratedLessonStatus; revision: number;
  chapters: GeneratedLessonChapter[]; duration: number;
  progress: GeneratedLessonProgress;
  error?: string; createdAt: string; updatedAt: string; approvedAt?: string; lessonId?: string;
  errorCode?: string; errorStage?: string; generationStartedAt?: string;
  engine?: 'legacy' | 'codex'; language?: GeneratedLessonLanguage; targetDuration?: 600; materialIds?: string[];
  /** Missing on historical lessons means 3D; newly created lessons default to 2D. */
  videoMode?: GeneratedLessonVideoMode;
  publication?: LessonPublication; artifact?: GeneratedLessonArtifact;
  voiceProfile?: GeneratedLessonVoiceProfile;
  languageReview?: { required: boolean; approvedAt?: string; approvedBy?: string };
  direction?: string; fitAttempts?: number; requestFingerprint?: string;
}
export interface LessonCatalogItem {
  id: string; lessonId?: string; title: string; subjectId: string; durationMinutes: number;
  status: GeneratedLessonStatus; cinemaId?: string; description?: string;
  materialId?: string; teacherId?: string; updatedAt?: string; createdAt?: string; language?: GeneratedLessonLanguage; videoMode?: GeneratedLessonVideoMode;
}
