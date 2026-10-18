import { create } from 'zustand';

/**
 * What the Settings window's theme gallery says — a result, a refusal, a
 * list of schemes to pick from, or a delete with its Undo — kept here rather
 * than in the gallery's own state, and never saved.
 *
 * Here because the gallery is unmounted whenever Settings closes or a search
 * hides its row, and an Undo on offer used to go with it without a word: the
 * themes it could bring back were lost to a search for "font". An Undo stays
 * until it is used or no longer applies (themeGalleryModel.js's
 * `undoOffered`); Reset All counts it before it runs (`pendingThemeUndo`).
 */
export const useThemeGalleryStore = create((set, get) => ({
  notice: null,
  setNotice: (notice) => set({ notice: notice ?? null }),
  /** The gallery went away: an Undo still on offer stays for when it is back; any other notice goes. */
  galleryClosed: () => {
    if (!get().notice?.undo) set({ notice: null });
  },
}));

export default useThemeGalleryStore;
