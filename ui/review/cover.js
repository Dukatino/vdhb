// Refresh a project's cached cover from the live player the user already opened.
// No hidden player, seeking or background refresh queue: the film page draws the moment on screen once more and copies it.
export function createLiveCover({ source, save, visible = () => !document.hidden }) {
  let attemptedRevision = null, timer = null, stopped = false;
  return {
    update() {
      const revision = source.info.revision;
      if (stopped || !visible() || !revision || revision === attemptedRevision || source.seeking) return;
      // Skip the opening fade.
      if (source.displayedTime < Math.min(2, source.duration * 0.3)) return;
      attemptedRevision = revision;
      clearTimeout(timer);
      timer = setTimeout(async () => {
        timer = null;
        if (stopped || !visible() || source.info.revision !== revision) return;
        try {
          const picture = await source.snapDisplayed(480);
          if (!picture || stopped || source.info.revision !== revision) return;
          const data = picture.toDataURL('image/jpeg', 0.82);
          await save({ data, revision });
        } catch { /* A cover failure must not interrupt playback or retry on every frame. */ }
      }, 0);
    },
    destroy() { stopped = true; clearTimeout(timer); timer = null; }
  };
}
