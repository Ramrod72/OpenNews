"use client";

import { useLocalStorage } from "./useLocalStorage";

export interface BookmarkedStory {
  slug: string;
  headline: string;
  categorySlug: string | null;
  categoryName: string | null;
  imageUrl: string | null;
  savedAt: string;
}

export interface SavedSearch {
  label: string;
  query: string;
  savedAt: string;
}

export function useBookmarks() {
  const [bookmarks, setBookmarks] = useLocalStorage<BookmarkedStory[]>("opennews:bookmarks", []);

  const isBookmarked = (slug: string) => bookmarks.some((b) => b.slug === slug);

  const toggleBookmark = (story: Omit<BookmarkedStory, "savedAt">) => {
    setBookmarks((prev) =>
      prev.some((b) => b.slug === story.slug)
        ? prev.filter((b) => b.slug !== story.slug)
        : [{ ...story, savedAt: new Date().toISOString() }, ...prev],
    );
  };

  return { bookmarks, isBookmarked, toggleBookmark };
}

export function useFollowedCategories() {
  const [followed, setFollowed] = useLocalStorage<string[]>("opennews:followed", []);
  const toggleFollow = (slug: string) => {
    setFollowed((prev) => (prev.includes(slug) ? prev.filter((s) => s !== slug) : [...prev, slug]));
  };
  return { followed, isFollowed: (slug: string) => followed.includes(slug), toggleFollow };
}

export function useHiddenCategories() {
  const [hidden, setHidden] = useLocalStorage<string[]>("opennews:hidden", []);
  const toggleHidden = (slug: string) => {
    setHidden((prev) => (prev.includes(slug) ? prev.filter((s) => s !== slug) : [...prev, slug]));
  };
  return { hidden, isHidden: (slug: string) => hidden.includes(slug), toggleHidden };
}

export function useSavedSearches() {
  const [saved, setSaved] = useLocalStorage<SavedSearch[]>("opennews:savedSearches", []);
  const saveSearch = (search: Omit<SavedSearch, "savedAt">) => {
    setSaved((prev) => [{ ...search, savedAt: new Date().toISOString() }, ...prev].slice(0, 25));
  };
  const removeSearch = (query: string) => {
    setSaved((prev) => prev.filter((s) => s.query !== query));
  };
  return { saved, saveSearch, removeSearch };
}
