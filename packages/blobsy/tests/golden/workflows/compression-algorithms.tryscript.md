---
sandbox: true
fixtures:
  - ../fixtures/small-file.txt
  - ../fixtures/another-file.txt
before: |
  git init -q -b main
  git config user.name "Blobsy Test"
  git config user.email "blobsy-test@example.com"
  mkdir -p remote
  mkdir -p data
  cp small-file.txt data/model.bin
  cp another-file.txt data/dataset.csv
---
# Gzip compression round-trip

```console
$ printf 'backends:\n  default:\n    url: "local:remote"\ncompress:\n  algorithm: gzip\n' > .blobsy.yml
? 0
```

```console
$ git add -A && git commit -q -m "init gzip"
? 0
```

```console
$ blobsy track data/model.bin
Tracking data/model.bin
Created data/model.bin.bref
Added data/model.bin to .gitignore
? 0
```

```console
$ git add -A && git commit -q -m "track"
? 0
```

```console
$ blobsy push data/model.bin
  data/model.bin (13 B) - pushed
Done: 1 pushed.
? 0
```

```console
$ rm data/model.bin
? 0
```

```console
$ blobsy pull data/model.bin
  data/model.bin (13 B) - pulled
Done: 1 pulled.
? 0
```

```console
$ cat data/model.bin
hello blobsy
? 0
```

# Brotli compression round-trip

```console
$ printf 'backends:\n  default:\n    url: "local:remote"\ncompress:\n  algorithm: brotli\n' > .blobsy.yml
? 0
```

```console
$ blobsy track data/dataset.csv
Tracking data/dataset.csv
Created data/dataset.csv.bref
Added data/dataset.csv to .gitignore
? 0
```

```console
$ git add -A && git commit -q -m "track csv"
? 0
```

```console
$ blobsy push data/dataset.csv
  data/dataset.csv (16 B) - pushed
Done: 1 pushed.
? 0
```

```console
$ rm data/dataset.csv
? 0
```

```console
$ blobsy pull data/dataset.csv
  data/dataset.csv (12 B) - pulled
Done: 1 pulled.
? 0
```

```console
$ cat data/dataset.csv
second file
? 0
```

# min_size threshold: small files skip compression

```console
$ printf 'backends:\n  default:\n    url: "local:remote"\ncompress:\n  algorithm: zstd\n  min_size: "100 KB"\n' > .blobsy.yml
? 0
```

```console
$ echo "tiny" > data/tiny.bin
? 0
```

```console
$ blobsy track data/tiny.bin
Tracking data/tiny.bin
Created data/tiny.bin.bref
Added data/tiny.bin to .gitignore
? 0
```

```console
$ git add -A && git commit -q -m "track tiny"
? 0
```

```console
$ blobsy push data/tiny.bin
  data/tiny.bin (5 B) - pushed
Done: 1 pushed.
? 0
```

```console
$ rm data/tiny.bin
? 0
```

```console
$ blobsy pull data/tiny.bin
  data/tiny.bin (5 B) - pulled
Done: 1 pulled.
? 0
```

```console
$ cat data/tiny.bin
tiny
? 0
```

# never pattern: excluded files skip compression

```console
$ printf 'backends:\n  default:\n    url: "local:remote"\ncompress:\n  algorithm: zstd\n  never:\n    - "*.txt"\n' > .blobsy.yml
? 0
```

```console
$ echo "plain text" > data/notes.txt
? 0
```

```console
$ blobsy track data/notes.txt
Tracking data/notes.txt
Created data/notes.txt.bref
Added data/notes.txt to .gitignore
? 0
```

```console
$ git add -A && git commit -q -m "track txt"
? 0
```

```console
$ blobsy push data/notes.txt
  data/notes.txt (11 B) - pushed
Done: 1 pushed.
? 0
```

```console
$ rm data/notes.txt
? 0
```

```console
$ blobsy pull data/notes.txt
  data/notes.txt (11 B) - pulled
Done: 1 pulled.
? 0
```

```console
$ cat data/notes.txt
plain text
? 0
```
