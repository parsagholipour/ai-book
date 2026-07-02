-- Add chapter-level regeneration as a first-class book edit operation kind.
ALTER TYPE "BookEditOperationKind" ADD VALUE 'CHAPTER_REGENERATE';
