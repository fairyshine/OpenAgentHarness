export interface DirectorySyncResult {
  localFingerprint: string;
  uploadedFileCount: number;
  deletedRemoteCount: number;
  createdEmptyDirectoryCount: number;
  requestCounts?: ObjectStoreRequestCounts | undefined;
  phaseTimings?: DirectorySyncPhaseTimings | undefined;
  bridgeTimings?: DirectorySyncBridgeTimings | undefined;
  workerTimings?: DirectorySyncWorkerTimings | undefined;
  wrapperTimings?: DirectorySyncWrapperTimings | undefined;
}

export interface RemoteToLocalDirectorySyncResult {
  localFingerprint?: string | undefined;
  removedPathCount: number;
  createdDirectoryCount: number;
  downloadedFileCount: number;
  requestCounts?: ObjectStoreRequestCounts | undefined;
  phaseTimings?: RemoteToLocalDirectorySyncPhaseTimings | undefined;
}

export interface ObjectStoreRequestCounts {
  listRequests: number;
  getRequests: number;
  headRequests: number;
  putRequests: number;
  deleteRequests: number;
}

export interface DirectorySyncPhaseTimings {
  scanMs: number;
  fingerprintMs: number;
  clientCreateMs: number;
  manifestReadMs: number;
  bundleBuildMs: number;
  bundleBodyPrepareMs: number;
  bundleUploadMs: number;
  bundleTransport: "none" | "memory" | "tempfile";
  bundleBytes: number;
  manifestWriteMs: number;
  deleteMs: number;
  totalPrimaryPathMs: number;
  totalCommandMs: number;
}

export interface RemoteToLocalDirectorySyncPhaseTimings {
  scanMs: number;
  clientCreateMs: number;
  listingMs: number;
  manifestReadMs: number;
  planMs: number;
  removeMs: number;
  mkdirMs: number;
  bundleGetMs: number;
  bundleBodyReadMs: number;
  bundleExtractMs: number;
  bundleExtractMkdirUs: number;
  bundleExtractReplaceUs: number;
  bundleExtractFileCreateUs: number;
  bundleExtractFileWriteUs: number;
  bundleExtractFileMtimeUs: number;
  bundleExtractChmodUs: number;
  bundleExtractTargetCheckUs: number;
  bundleExtractFileCount: number;
  bundleExtractDirectoryCount: number;
  bundleTransport: "none" | "memory" | "tempfile";
  bundleExtractor: "none" | "rust-ustar" | "rust-ustar-stream" | "tar";
  bundleBytes: number;
  downloadMs: number;
  infoCheckMs: number;
  fingerprintMs: number;
  totalCommandMs: number;
}

export interface DirectorySyncWrapperTimings {
  nativeCallMs: number;
  pruneEmptyDirectoriesMs: number;
  totalNativeWrapperMs: number;
}

export interface DirectorySyncBridgeTimings {
  mode: "persistent" | "oneshot";
  poolInitMs: number;
  queueWaitMs: number;
  writeMs: number;
  responseWaitMs: number;
  totalBridgeMs: number;
}

export interface DirectorySyncWorkerTimings {
  receiveDelayMs: number;
  parseMs: number;
  handleMs: number;
  serializeMs: number;
  writeMs: number;
  totalWorkerMs: number;
}
