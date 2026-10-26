export type DerivativeSceneKey = 'intro' | 'motion' | 'average' | 'secant' | 'limit' | 'tangent' | 'rules' | 'chain' | 'extrema' | 'outro';

export type CinemaBeat = {
  at: number;
  kicker?: string;
  headline: string;
  formula?: string;
  note?: string;
  emphasis?: 'hero' | 'equation' | 'number';
};

export type CinemaChapter = {
  id: string;
  title: string;
  scene: DerivativeSceneKey;
  start: number;
  duration: number;
  formula?: string;
  caption?: string;
  cues?: { at: number; text: string }[];
  beats?: CinemaBeat[];
  audioUrl?: string;
  audioDuration?: number;
};

export type CinemaManifest = {
  id: string;
  title: string;
  duration: number;
  chapters: CinemaChapter[];
  voice: { status: 'ready' | 'missing'; model: string | null; voice: string | null };
};

export type DerivativeFilmProps = {
  sessionId: string;
  preview?: boolean;
  paused: boolean;
  busy?: boolean;
  cameraLabel?: string;
  cameraError?: boolean;
  attendanceCount?: string;
  onPause: () => void;
  onResume: () => void;
  onFinish: () => void;
  onAttendance: () => void;
  onRetryCamera?: () => void;
  onExit?: () => void;
};
