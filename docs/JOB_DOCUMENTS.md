# Job documents

Every job card has an **Attach JD** control. It accepts PDF, DOCX, and UTF-8 TXT files up to 10 MB. Uploaded documents are stored with the job in PostgreSQL, listed by filename on the card, and remain available after an app release. The remove button deletes only the selected uploaded copy after confirmation.

When Joseph supplies a job ID in a future chat, read the newest attached document with:

```bash
npm run jd:read -- <job-id>
```

The command prints the document text and identifies any other attachments. To read a specific one, add its attachment ID:

```bash
npm run jd:read -- <job-id> <attachment-id>
```

The same documents are available through `GET /api/jobs/<job-id>/attachments` for metadata and `GET /api/jobs/<job-id>/attachments/<attachment-id>` for the original bytes. PDFs without extractable text require OCR or visual inspection of the original file.

Uploading or removing a document does not change the job's description, score, or scoring queue. The uploaded document is reference material for interview prep and other human-facing work.
