export type RigidKeyframe = { t: number; rotation: number[]; translation: number[] };
export type RigidTrack = { id: string; chains: string[]; selector?: {residues?: {from:number;to:number}[]; componentIds?:string[]}; pivot?:number[]; keyframes: RigidKeyframe[]; visibility?: { t: number; visible: boolean }[] };
export type MolecularAnimation = { version: 1; durationSeconds: number; tracks: RigidTrack[]; playback?: { autoplay?: boolean; loop?: boolean; speed?: number } };
export type AnimationPatch = { state?: 'play' | 'pause'; speed?: number; loop?: boolean; seekSeconds?: number; restart?: true };
export type AnimationPlayback = { state: 'playing' | 'paused'; timeSeconds: number; speed: number; loop: boolean };
export function evaluateTrackVisibility(track: RigidTrack, seconds: number): boolean;
export function evaluateTrack(track: RigidTrack, seconds: number, out?: { rotation: number[]; translation: number[]; visible: boolean }): { rotation: number[]; translation: number[]; visible: boolean };
export function createPlaybackClock(durationSeconds: number, playback?: MolecularAnimation['playback']): {
  sample(timestamp: number, out?: AnimationPlayback): AnimationPlayback;
  patch(value: AnimationPatch, timestamp?: number): AnimationPlayback;
  snapshot(out?: AnimationPlayback): AnimationPlayback;
  reanchor(): void;
};
