/** Desktop chapter fits must not redefine the headset's model-to-room frame.
 * Carry the saved viewing direction and up, using the pre-lesson source fit's
 * target and distance. Saved XR scenes and later chapters keep their own frame.
 */
export function lessonEntryCameraScene(scene: any, firstChapterId?: string): any {
  const playback = scene?.inspection?.lessonPlayback;
  const start = playback?.startingScene?.camera, camera = scene?.camera;
  if (!start || !camera || playback.cameraFrame !== 'desktop' || playback.stopped
    || playback.entry !== 'start' || playback.chapterId !== firstChapterId) return scene;
  const direction = camera.position.map((v: number, i: number) => v - camera.target[i]);
  const distance = Math.hypot(...start.position.map((v: number, i: number) => v - start.target[i]));
  const length = Math.hypot(...direction);
  if (!(length > 0 && distance > 0)) return scene;
  const result = structuredClone(scene);
  result.camera = { ...camera, target: [...start.target],
    position: start.target.map((v: number, i: number) => v + distance * direction[i] / length),
    radius: start.radius, radiusMax: start.radiusMax };
  return result;
}
