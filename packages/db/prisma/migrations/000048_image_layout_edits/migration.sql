-- Chat-requested move/remove of an existing illustration: no generation, tracked
-- as their own edit-operation kinds so undo and the history label stay honest.
ALTER TYPE "BookEditOperationKind" ADD VALUE IF NOT EXISTS 'MOVE_IMAGE';
ALTER TYPE "BookEditOperationKind" ADD VALUE IF NOT EXISTS 'REMOVE_IMAGE';
