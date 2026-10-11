/** One deliberately narrow acceptance command, never a general model tool executor. */
export function permitsLiveOrangeAction(transcript: string): boolean {
  const line = transcript.toLowerCase().replace(/[.,!?]/g, '').replace(/\s+/g, ' ').trim();
  return /^(?:the protein is ready )?colou?r (?:the )?selected residues orange$/.test(line);
}
