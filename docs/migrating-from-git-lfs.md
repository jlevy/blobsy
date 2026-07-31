# Migrating from Git LFS

How to move a repository from Git LFS to blobsy.
There is no automated migration command yet; this is a manual but mechanical process.

## Before you start

- Make sure every collaborator has pushed their work; migrate on a quiet branch.
- Note that migration changes how large files are stored **going forward**. Old commits
  keep their LFS pointers; this guide does not rewrite history.

## Steps

1. **Materialize all LFS content locally** (turn pointers back into real files):

   ```bash
   git lfs pull
   git lfs checkout
   ```

2. **Remove the LFS filters** so git stops intercepting the files:

   ```bash
   git lfs uninstall --local
   ```

   Then delete (or edit) the `filter=lfs` lines in `.gitattributes` and commit that
   change.

3. **Remove the files from git’s index** (keep them on disk):

   ```bash
   git rm --cached path/to/large-file.bin
   ```

   For many files, `git lfs ls-files -n` lists every LFS-tracked path.

4. **Set up blobsy** (if not already):

   ```bash
   npm install -g blobsy
   blobsy setup --auto s3://your-bucket/your-prefix/
   ```

5. **Track the files with blobsy and stage the results:**

   ```bash
   blobsy add path/to/large-file.bin        # track + git add in one step
   # or per directory:
   blobsy add data/
   ```

   `blobsy add` creates a `.bref` pointer, adds the payload to `.gitignore`, and stages
   both.

6. **Upload and commit:**

   ```bash
   blobsy push
   git commit -m "Migrate large files from Git LFS to blobsy"
   git push
   ```

   (With hooks installed, the pre-push hook uploads any unpushed blobs automatically.)

7. **Verify:**

   ```bash
   blobsy status
   blobsy verify
   ```

## Notes

- **History:** old commits still reference LFS objects.
  Keep the LFS server data until you no longer need to check out those commits, or
  rewrite history with `git filter-repo` separately (out of scope here).
- **Collaborators** should pull the migration commit, run `npm install -g blobsy`, then
  `blobsy setup --auto` (config is already in the repo) and `blobsy pull`. See
  [joining-a-blobsy-repo.md](joining-a-blobsy-repo.md).
