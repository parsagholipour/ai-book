-- Where each model page landed in the published book.pdf, measured at publish
-- time from the rendered bytes. Null until the book's next compile.
ALTER TABLE "Project" ADD COLUMN "pdfPageMap" JSONB;
