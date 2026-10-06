-- What a file was uploaded for, when it was not uploaded as a document.
--
-- Null for everything already here, which is the knowledge collection and is what this store is
-- mostly for. The one value that exists so far is 'CompanyIdentityImage': a picture placed inside
-- the company Vision or Mission.
--
-- The column exists because those pictures need a different door. Reading a knowledge document
-- needs `settings:Export`; a picture inside the Mission has to be readable by everybody who can
-- open the Hierarchy, because that is who the Mission is written for. A route that served any
-- file by its id to anybody holding `hierarchy:View` would be a way to read the company's
-- documents, so the route asks for this mark and refuses a file that does not carry it.
--
-- Hand-written: `prisma migrate diff` also emits pre-existing drift on this database -- DEFAULT
-- removals on three updated_at columns and two constraint renames -- none of which belong here.

ALTER TABLE "files" ADD COLUMN "purpose" VARCHAR(40);
