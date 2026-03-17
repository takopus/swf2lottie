export type BitmapAssetMode = "inline" | "external";

export interface ExportedBitmapAsset {
  symbolId: string;
  assetId: string;
  filename: string;
  mimeType: "image/jpeg" | "image/png" | "image/gif";
  dataBase64: string;
  width: number;
  height: number;
}

export interface LottieExportResult {
  animation: Record<string, unknown> | null;
  bitmapAssets: ExportedBitmapAsset[];
}

export interface LottieExportOptions {
  bitmapAssetMode?: BitmapAssetMode;
  bitmapAssetBasePath?: string;
}
