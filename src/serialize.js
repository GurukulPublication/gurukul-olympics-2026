export function toApiPhoto(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    name: row.original_name,
    path: row.source_path || '',
    album: row.album || '',
    caption: row.caption || '',
    tags: row.tags || '',
    favorite: !!row.favorite,
    mime: row.mime || '',
    size: Number(row.size || 0),
    width: row.width ?? null,
    height: row.height ?? null,
    takenAt: row.taken_at || null,
    uploadedAt: row.uploaded_at || null,
    deletedAt: row.deleted_at || null,
    thumbUrl: row.thumb_path ? `/media/thumbs/${row.thumb_path}` : null,
    previewUrl: row.preview_path ? `/media/previews/${row.preview_path}` : null,
    originalUrl: `/api/photos/${row.id}/original`,
    downloadUrl: `/api/photos/${row.id}/download`,
    thumbOk: row.thumb_status === 'ok'
  };
}
