import { createReadStream, createWriteStream } from "node:fs";
import { stat, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import type { NativeWorkspaceSyncObjectStoreConfig } from "@oah/native-bridge";

import { recordObjectStorageOperation, type ObjectStorageMetricOperation } from "./observability/object-storage.js";
import {
  createObjectStorageSyncBudget,
  resolveObjectStorageMaxAttempts,
  resolveObjectStorageMultipartPartSizeBytes,
  resolveObjectStorageMultipartThresholdBytes,
  resolveObjectStorageRequestTimeoutMs
} from "./object-storage-config.js";
import {
  OBJECT_MTIME_METADATA_KEY,
  type DirectoryObjectStore,
  type ObjectStorageConfig,
  type ObjectStorageDirectoryEntry,
  type ObjectStorageEntry
} from "./object-storage-types.js";

type AwsS3Module = typeof import("@aws-sdk/client-s3");
type AwsS3ModuleImport = AwsS3Module | { default?: AwsS3Module | undefined };
type AwsS3ClientLike = {
  send(command: unknown, options?: { abortSignal?: AbortSignal | undefined }): Promise<unknown>;
  destroy(): void;
};

let awsS3ModulePromise: Promise<AwsS3Module> | undefined;

export function normalizeAwsS3Module(module: AwsS3ModuleImport): AwsS3Module {
  if (typeof (module as AwsS3Module).S3Client === "function") {
    return module as AwsS3Module;
  }

  const defaultExport = (module as { default?: AwsS3Module | undefined }).default;
  if (defaultExport && typeof defaultExport.S3Client === "function") {
    return defaultExport;
  }

  throw new TypeError("Failed to load @aws-sdk/client-s3: S3Client export is unavailable.");
}

function loadAwsS3Module(): Promise<AwsS3Module> {
  awsS3ModulePromise ??= import("@aws-sdk/client-s3").then(normalizeAwsS3Module);
  return awsS3ModulePromise;
}

function normalizePrefix(prefix: string): string {
  return prefix.replace(/^\/+|\/+$/g, "");
}

async function collectObjectStorageEntries(store: DirectoryObjectStore, prefix: string): Promise<ObjectStorageEntry[]> {
  const budget = createObjectStorageSyncBudget(`object storage prefix ${(prefix || ".").trim() || "."}`);
  if (!store.listEntriesPaged) {
    const entries = await store.listEntries(prefix);
    for (const entry of entries) {
      budget.observeObject();
      budget.observeBytes(entry.size);
    }
    return entries;
  }

  const entries: ObjectStorageEntry[] = [];
  for await (const page of store.listEntriesPaged(prefix)) {
    for (const entry of page) {
      budget.observeObject();
      budget.observeBytes(entry.size);
    }
    entries.push(...page);
  }
  return entries.sort((left, right) => left.key.localeCompare(right.key));
}

async function streamBodyToBuffer(body: unknown): Promise<Buffer> {
  if (!body) {
    return Buffer.alloc(0);
  }

  if (typeof body === "string") {
    return Buffer.from(body);
  }

  if (body instanceof Uint8Array) {
    return Buffer.from(body);
  }

  if (typeof body === "object" && body !== null && "transformToByteArray" in body) {
    const bytes = await (body as { transformToByteArray(): Promise<Uint8Array> }).transformToByteArray();
    return Buffer.from(bytes);
  }

  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Uint8Array | Buffer | string>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function writeStreamBodyToFile(body: unknown, targetPath: string): Promise<void> {
  if (!body) {
    await writeFile(targetPath, Buffer.alloc(0));
    return;
  }

  if (typeof body === "string" || body instanceof Uint8Array) {
    await writeFile(targetPath, body);
    return;
  }

  if (typeof body === "object" && body !== null && "pipe" in body && typeof body.pipe === "function") {
    await pipeline(body as NodeJS.ReadableStream, createWriteStream(targetPath));
    return;
  }

  if (typeof body === "object" && body !== null && "transformToByteArray" in body) {
    const bytes = await (body as { transformToByteArray(): Promise<Uint8Array> }).transformToByteArray();
    await writeFile(targetPath, bytes);
    return;
  }

  await pipeline(Readable.from(body as AsyncIterable<Uint8Array | Buffer | string>), createWriteStream(targetPath));
}

function readableFromStreamBody(body: unknown): NodeJS.ReadableStream {
  if (!body) {
    return Readable.from([]);
  }
  if (typeof body === "string" || body instanceof Uint8Array) {
    return Readable.from([body]);
  }
  if (typeof body === "object" && body !== null && "pipe" in body && typeof body.pipe === "function") {
    return body as NodeJS.ReadableStream;
  }
  if (typeof body === "object" && body !== null && "transformToByteArray" in body) {
    return Readable.from(
      (async function* () {
        yield await (body as { transformToByteArray(): Promise<Uint8Array> }).transformToByteArray();
      })()
    );
  }
  return Readable.from(body as AsyncIterable<Uint8Array | Buffer | string>);
}

function objectStorageErrorCode(error: unknown): string {
  if (!error || typeof error !== "object") {
    return "";
  }
  const record = error as { name?: unknown; code?: unknown; Code?: unknown; $metadata?: { httpStatusCode?: number | undefined } };
  return String(record.code ?? record.Code ?? record.name ?? "").toLowerCase();
}

function objectStorageHttpStatus(error: unknown): number | undefined {
  return error && typeof error === "object"
    ? (error as { $metadata?: { httpStatusCode?: number | undefined } }).$metadata?.httpStatusCode
    : undefined;
}

function isTimeoutLikeObjectStorageError(error: unknown): boolean {
  const code = objectStorageErrorCode(error);
  return code.includes("abort") || code.includes("timeout") || code.includes("timedout");
}

function isThrottlingObjectStorageError(error: unknown): boolean {
  const code = objectStorageErrorCode(error);
  const status = objectStorageHttpStatus(error);
  return status === 429 || code.includes("throttl") || code.includes("slowdown") || code.includes("toomanyrequests");
}

function isRetryableObjectStorageError(error: unknown): boolean {
  const status = objectStorageHttpStatus(error);
  return status === 408 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

export class S3DirectoryStore implements DirectoryObjectStore {
  readonly #bucket: string;
  readonly #config: ObjectStorageConfig;
  #clientPromise: Promise<AwsS3ClientLike> | undefined;

  constructor(config: ObjectStorageConfig) {
    this.#config = config;
    this.#bucket = config.bucket;
  }

  get bucket(): string {
    return this.#bucket;
  }

  async #getClient(): Promise<AwsS3ClientLike> {
    if (!this.#clientPromise) {
      this.#clientPromise = loadAwsS3Module()
        .then(({ S3Client }) => {
          return new S3Client({
            region: this.#config.region,
            ...(this.#config.endpoint ? { endpoint: this.#config.endpoint } : {}),
            ...(this.#config.force_path_style !== undefined ? { forcePathStyle: this.#config.force_path_style } : {}),
            ...(this.#config.access_key || this.#config.secret_key || this.#config.session_token
              ? {
                  credentials: {
                    accessKeyId: this.#config.access_key ?? "",
                    secretAccessKey: this.#config.secret_key ?? "",
                    ...(this.#config.session_token ? { sessionToken: this.#config.session_token } : {})
                  }
                }
              : {})
          }) as AwsS3ClientLike;
        })
        .catch((error) => {
          this.#clientPromise = undefined;
          throw error;
        });
    }

    return this.#clientPromise;
  }

  async #send<TResponse>(
    command: unknown,
    operation: ObjectStorageMetricOperation
  ): Promise<{ response: TResponse; retries: number }> {
    const client = await this.#getClient();
    const maxAttempts = Math.max(1, resolveObjectStorageMaxAttempts());
    const timeoutMs = resolveObjectStorageRequestTimeoutMs();
    let retries = 0;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = (await client.send(command, { abortSignal: controller.signal })) as TResponse;
        clearTimeout(timeoutHandle);
        return { response, retries };
      } catch (error) {
        clearTimeout(timeoutHandle);
        const timeout = controller.signal.aborted || isTimeoutLikeObjectStorageError(error);
        const throttled = isThrottlingObjectStorageError(error);
        const retryable = timeout || throttled || isRetryableObjectStorageError(error);
        if (retryable) {
          recordObjectStorageOperation({
            operation,
            countOperation: false,
            ...(timeout ? { timeout: true } : {}),
            ...(throttled ? { throttled: true } : {})
          });
        }
        if (!retryable || attempt >= maxAttempts) {
          throw error;
        }
        retries += 1;
        recordObjectStorageOperation({
          operation,
          countOperation: false,
          retries: 1
        });
        await new Promise((resolve) => setTimeout(resolve, Math.min(1000, 50 * 2 ** (attempt - 1))));
      }
    }

    throw new Error("unreachable object storage retry state");
  }

  #metadataFromOptions(options?: { mtimeMs?: number | undefined }): Record<string, string> | undefined {
    return typeof options?.mtimeMs === "number" && Number.isFinite(options.mtimeMs) && options.mtimeMs > 0
      ? {
          [OBJECT_MTIME_METADATA_KEY]: String(Math.trunc(options.mtimeMs))
        }
      : undefined;
  }

  async #putObjectStreamMultipart(
    key: string,
    body: NodeJS.ReadableStream,
    options?: { mtimeMs?: number | undefined }
  ): Promise<void> {
    const {
      AbortMultipartUploadCommand,
      CompleteMultipartUploadCommand,
      CreateMultipartUploadCommand,
      PutObjectCommand,
      UploadPartCommand
    } = await loadAwsS3Module();
    const partSize = resolveObjectStorageMultipartPartSizeBytes();
    const startedAt = performance.now();
    let uploadId: string | undefined;
    let retries = 0;
    let uploadedBytes = 0;
    const completedParts: Array<{ ETag?: string | undefined; PartNumber: number }> = [];

    const metadata = this.#metadataFromOptions(options);
    const uploadPart = async (partNumber: number, partBody: Buffer): Promise<void> => {
      const { response, retries: partRetries } = await this.#send<{ ETag?: string | undefined }>(
        new UploadPartCommand({
          Bucket: this.#bucket,
          Key: key,
          UploadId: uploadId,
          PartNumber: partNumber,
          Body: partBody,
          ContentLength: partBody.length
        }),
        "multipart_upload"
      );
      retries += partRetries;
      uploadedBytes += partBody.length;
      completedParts.push({
        PartNumber: partNumber,
        ...(response.ETag ? { ETag: response.ETag } : {})
      });
    };

    try {
      const createResult = await this.#send<{ UploadId?: string | undefined }>(
        new CreateMultipartUploadCommand({
          Bucket: this.#bucket,
          Key: key,
          ...(metadata ? { Metadata: metadata } : {})
        }),
        "multipart_upload"
      );
      retries += createResult.retries;
      uploadId = createResult.response.UploadId;
      if (!uploadId) {
        throw new Error(`S3 multipart upload for ${key} did not return an upload id.`);
      }

      let pending = Buffer.alloc(0);
      let partNumber = 1;
      for await (const chunk of body as AsyncIterable<Uint8Array | Buffer | string>) {
        const buffer = Buffer.from(chunk);
        pending = pending.length === 0 ? buffer : Buffer.concat([pending, buffer]);
        while (pending.length >= partSize) {
          const part = pending.subarray(0, partSize);
          pending = pending.subarray(partSize);
          await uploadPart(partNumber, part);
          partNumber += 1;
        }
      }

      if (pending.length > 0) {
        await uploadPart(partNumber, pending);
      }

      if (completedParts.length === 0) {
        const putStartedAt = performance.now();
        const { retries: putRetries } = await this.#send(
          new PutObjectCommand({
            Bucket: this.#bucket,
            Key: key,
            Body: Buffer.alloc(0),
            ContentLength: 0,
            ...(metadata ? { Metadata: metadata } : {})
          }),
          "put"
        );
        recordObjectStorageOperation({
          operation: "put",
          durationMs: Math.max(0, Math.round(performance.now() - putStartedAt)),
          retries: putRetries,
          objectsUploaded: 1
        });
        return;
      }

      const completeResult = await this.#send(
        new CompleteMultipartUploadCommand({
          Bucket: this.#bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: {
            Parts: completedParts
          }
        }),
        "multipart_upload"
      );
      retries += completeResult.retries;
      recordObjectStorageOperation({
        operation: "multipart_upload",
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
        retries,
        bytesUploaded: uploadedBytes,
        objectsUploaded: 1
      });
    } catch (error) {
      if (uploadId) {
        await this.#send(
          new AbortMultipartUploadCommand({
            Bucket: this.#bucket,
            Key: key,
            UploadId: uploadId
          }),
          "multipart_upload"
        ).catch(() => undefined);
      }
      throw error;
    }
  }

  getNativeWorkspaceSyncConfig(): NativeWorkspaceSyncObjectStoreConfig {
    return {
      bucket: this.#config.bucket,
      region: this.#config.region,
      ...(this.#config.endpoint ? { endpoint: this.#config.endpoint } : {}),
      ...(this.#config.force_path_style !== undefined ? { forcePathStyle: this.#config.force_path_style } : {}),
      ...(this.#config.access_key ? { accessKey: this.#config.access_key } : {}),
      ...(this.#config.secret_key ? { secretKey: this.#config.secret_key } : {}),
      ...(this.#config.session_token ? { sessionToken: this.#config.session_token } : {})
    };
  }

  async *listEntriesPaged(prefix: string): AsyncIterable<ObjectStorageEntry[]> {
    const { ListObjectsV2Command } = await loadAwsS3Module();
    const normalizedPrefix = normalizePrefix(prefix);
    let continuationToken: string | undefined;

    do {
      const startedAt = performance.now();
      const { response, retries } = await this.#send<{
        Contents?: Array<{ Key?: string | undefined; Size?: number | undefined; LastModified?: Date | undefined }>;
        IsTruncated?: boolean | undefined;
        NextContinuationToken?: string | undefined;
      }>(
        new ListObjectsV2Command({
          Bucket: this.#bucket,
          ...(normalizedPrefix ? { Prefix: `${normalizedPrefix}/` } : {}),
          ...(continuationToken ? { ContinuationToken: continuationToken } : {})
        }),
        "list"
      );

      const page: ObjectStorageEntry[] = [];
      for (const item of response.Contents ?? []) {
        if (!item.Key) {
          continue;
        }

        page.push({
          key: item.Key,
          size: item.Size ?? 0,
          ...(item.LastModified ? { lastModified: item.LastModified } : {})
        });
      }
      recordObjectStorageOperation({
        operation: "list",
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
        retries,
        objectsListed: page.length
      });

      if (page.length > 0) {
        yield page.sort((left, right) => left.key.localeCompare(right.key));
      }
      continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
    } while (continuationToken);
  }

  async listEntries(prefix: string): Promise<ObjectStorageEntry[]> {
    return collectObjectStorageEntries(this, prefix);
  }

  async listDirectoryEntries(prefix: string, directory: string): Promise<ObjectStorageDirectoryEntry[]> {
    const { ListObjectsV2Command } = await loadAwsS3Module();
    const normalizedPrefix = normalizePrefix(prefix);
    const normalizedDirectory = normalizePrefix(directory);
    const requestPrefix = [normalizedPrefix, normalizedDirectory].filter((segment) => segment.length > 0).join("/");
    const prefixWithSlash = requestPrefix ? `${requestPrefix}/` : "";
    let continuationToken: string | undefined;
    const entries: ObjectStorageDirectoryEntry[] = [];

    do {
      const startedAt = performance.now();
      const { response, retries } = await this.#send<{
        Contents?: Array<{ Key?: string | undefined; Size?: number | undefined; LastModified?: Date | undefined }>;
        CommonPrefixes?: Array<{ Prefix?: string | undefined }>;
        IsTruncated?: boolean | undefined;
        NextContinuationToken?: string | undefined;
      }>(
        new ListObjectsV2Command({
          Bucket: this.#bucket,
          Prefix: prefixWithSlash,
          Delimiter: "/",
          ...(continuationToken ? { ContinuationToken: continuationToken } : {})
        }),
        "list"
      );

      for (const item of response.Contents ?? []) {
        if (!item.Key || item.Key === requestPrefix || item.Key === prefixWithSlash) {
          continue;
        }
        const relativeName = item.Key.slice(prefixWithSlash.length).replace(/\/+$/u, "");
        if (!relativeName || relativeName.includes("/")) {
          continue;
        }
        entries.push({
          name: relativeName,
          kind: "file",
          size: item.Size ?? 0,
          ...(item.LastModified ? { lastModified: item.LastModified } : {})
        });
      }

      for (const item of response.CommonPrefixes ?? []) {
        if (!item.Prefix || item.Prefix === prefixWithSlash) {
          continue;
        }
        const relativeName = item.Prefix.slice(prefixWithSlash.length).replace(/\/+$/u, "");
        if (!relativeName || relativeName.includes("/")) {
          continue;
        }
        entries.push({
          name: relativeName,
          kind: "directory"
        });
      }

      recordObjectStorageOperation({
        operation: "list",
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
        retries,
        objectsListed: (response.Contents?.length ?? 0) + (response.CommonPrefixes?.length ?? 0)
      });

      continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
    } while (continuationToken);

    return entries.sort((left, right) => left.name.localeCompare(right.name));
  }

  async getObject(key: string): Promise<{ body: Buffer; metadata?: Record<string, string> | undefined }> {
    const { GetObjectCommand } = await loadAwsS3Module();
    const startedAt = performance.now();
    const { response, retries } = await this.#send<{
      Body?: unknown;
      Metadata?: Record<string, string> | undefined;
      ContentLength?: number | undefined;
    }>(
      new GetObjectCommand({
        Bucket: this.#bucket,
        Key: key
      }),
      "get"
    );
    const body = await streamBodyToBuffer(response.Body);
    recordObjectStorageOperation({
      operation: "get",
      durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      retries,
      bytesDownloaded: body.length,
      objectsDownloaded: 1
    });
    return {
      body,
      metadata: response.Metadata
    };
  }

  async getObjectStream(key: string): Promise<{ body: NodeJS.ReadableStream; metadata?: Record<string, string> | undefined }> {
    const { GetObjectCommand } = await loadAwsS3Module();
    const startedAt = performance.now();
    const { response, retries } = await this.#send<{
      Body?: unknown;
      Metadata?: Record<string, string> | undefined;
      ContentLength?: number | undefined;
    }>(
      new GetObjectCommand({
        Bucket: this.#bucket,
        Key: key
      }),
      "get"
    );
    recordObjectStorageOperation({
      operation: "get",
      durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      retries,
      bytesDownloaded: response.ContentLength,
      objectsDownloaded: 1
    });
    return {
      body: readableFromStreamBody(response.Body),
      metadata: response.Metadata
    };
  }

  async getObjectToFile(key: string, targetPath: string): Promise<{ metadata?: Record<string, string> | undefined }> {
    const { GetObjectCommand } = await loadAwsS3Module();
    const startedAt = performance.now();
    const { response, retries } = await this.#send<{
      Body?: unknown;
      Metadata?: Record<string, string> | undefined;
      ContentLength?: number | undefined;
    }>(
      new GetObjectCommand({
        Bucket: this.#bucket,
        Key: key
      }),
      "get"
    );
    await writeStreamBodyToFile(response.Body, targetPath);
    const fileStat = await stat(targetPath).catch(() => undefined);
    recordObjectStorageOperation({
      operation: "get",
      durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      retries,
      bytesDownloaded: fileStat?.size ?? response.ContentLength,
      objectsDownloaded: 1
    });
    return {
      metadata: response.Metadata
    };
  }

  async getObjectInfo(
    key: string
  ): Promise<{ size?: number | undefined; lastModified?: Date | undefined; metadata?: Record<string, string> | undefined }> {
    const { HeadObjectCommand } = await loadAwsS3Module();
    const startedAt = performance.now();
    const { response, retries } = await this.#send<{
      ContentLength?: number | undefined;
      LastModified?: Date | undefined;
      Metadata?: Record<string, string> | undefined;
    }>(
      new HeadObjectCommand({
        Bucket: this.#bucket,
        Key: key
      }),
      "head"
    );
    recordObjectStorageOperation({
      operation: "head",
      durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      retries
    });

    return {
      ...(typeof response.ContentLength === "number" ? { size: response.ContentLength } : {}),
      ...(response.LastModified ? { lastModified: response.LastModified } : {}),
      ...(response.Metadata ? { metadata: response.Metadata } : {})
    };
  }

  async putObject(key: string, body: Buffer, options?: { mtimeMs?: number | undefined }): Promise<void> {
    const { PutObjectCommand } = await loadAwsS3Module();
    const startedAt = performance.now();
    const { retries } = await this.#send(
      new PutObjectCommand({
        Bucket: this.#bucket,
        Key: key,
        Body: body,
        ContentLength: body.length,
        ...(this.#metadataFromOptions(options) ? { Metadata: this.#metadataFromOptions(options) } : {})
      }),
      "put"
    );
    recordObjectStorageOperation({
      operation: "put",
      durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      retries,
      bytesUploaded: body.length,
      objectsUploaded: 1
    });
  }

  async putObjectFromStream(key: string, body: NodeJS.ReadableStream, options?: { mtimeMs?: number | undefined }): Promise<void> {
    await this.#putObjectStreamMultipart(key, body, options);
  }

  async putObjectFromFile(key: string, filePath: string, options?: { mtimeMs?: number | undefined }): Promise<void> {
    const fileStat = await stat(filePath);
    if (fileStat.size >= resolveObjectStorageMultipartThresholdBytes()) {
      await this.#putObjectStreamMultipart(key, createReadStream(filePath), options);
      return;
    }

    const { PutObjectCommand } = await loadAwsS3Module();
    const startedAt = performance.now();
    const { retries } = await this.#send(
      new PutObjectCommand({
        Bucket: this.#bucket,
        Key: key,
        Body: createReadStream(filePath),
        ContentLength: fileStat.size,
        ...(this.#metadataFromOptions(options) ? { Metadata: this.#metadataFromOptions(options) } : {})
      }),
      "put"
    );
    recordObjectStorageOperation({
      operation: "put",
      durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      retries,
      bytesUploaded: fileStat.size,
      objectsUploaded: 1
    });
  }

  async deleteObjects(keys: string[]): Promise<void> {
    if (keys.length === 0) {
      return;
    }

    const { DeleteObjectsCommand } = await loadAwsS3Module();
    for (let index = 0; index < keys.length; index += 1000) {
      const chunk = keys.slice(index, index + 1000);
      const startedAt = performance.now();
      const { retries } = await this.#send(
        new DeleteObjectsCommand({
          Bucket: this.#bucket,
          Delete: {
            Objects: chunk.map((key) => ({ Key: key })),
            Quiet: true
          }
        }),
        "delete"
      );
      recordObjectStorageOperation({
        operation: "delete",
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
        retries,
        objectsDeleted: chunk.length
      });
    }
  }

  async deletePrefix(prefix: string): Promise<number> {
    const normalizedPrefix = normalizePrefix(prefix);
    if (!normalizedPrefix) {
      throw new Error("Refusing to delete an empty object storage prefix.");
    }

    const { DeleteObjectsCommand, ListObjectsV2Command } = await loadAwsS3Module();
    let deletedCount = 0;
    const deleteChunk = async (keys: string[]): Promise<void> => {
      if (keys.length === 0) {
        return;
      }
      const startedAt = performance.now();
      const { retries } = await this.#send(
        new DeleteObjectsCommand({
          Bucket: this.#bucket,
          Delete: {
            Objects: keys.map((key) => ({ Key: key })),
            Quiet: true
          }
        }),
        "delete"
      );
      recordObjectStorageOperation({
        operation: "delete",
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
        retries,
        objectsDeleted: keys.length
      });
      deletedCount += keys.length;
    };

    let continuationToken: string | undefined;
    do {
      const startedAt = performance.now();
      const { response, retries } = await this.#send<{
        Contents?: Array<{ Key?: string | undefined }>;
        IsTruncated?: boolean | undefined;
        NextContinuationToken?: string | undefined;
      }>(
        new ListObjectsV2Command({
          Bucket: this.#bucket,
          Prefix: `${normalizedPrefix}/`,
          ...(continuationToken ? { ContinuationToken: continuationToken } : {})
        }),
        "list"
      );
      const keys = (response.Contents ?? []).map((item) => item.Key).filter((key): key is string => Boolean(key));
      recordObjectStorageOperation({
        operation: "list",
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
        retries,
        objectsListed: keys.length
      });
      await deleteChunk(keys);
      continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
    } while (continuationToken);

    await deleteChunk([normalizedPrefix, `${normalizedPrefix}/`]);
    return deletedCount;
  }

  async close(): Promise<void> {
    const client = await this.#clientPromise?.catch(() => undefined);
    client?.destroy();
  }
}
