-- Chat-requested image insertion: a priced one-off illustration appended to an
-- existing page's markdown, tracked as its own edit-operation kind.
ALTER TYPE "BookEditOperationKind" ADD VALUE IF NOT EXISTS 'ADD_IMAGE';
