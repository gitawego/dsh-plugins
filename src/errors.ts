/** dsh-vision error taxonomy: a stable code plus a human message. */
export type VisionErrorCode =
  | 'not_configured'
  | 'disabled'
  | 'model_not_found'
  | 'auth_error'
  | 'auth_failed'
  | 'not_found'
  | 'not_a_file'
  | 'too_large'
  | 'unsupported_format'
  | 'read_error'
  | 'invalid_data_url'
  | 'invalid_base64'
  | 'local_only'
  | 'vision_call_error'
  | 'image_delivery_unavailable'
  | 'aborted'
  | 'batch_too_large'
  | 'no_image_path'
  | 'unexpected'

export class VisionError extends Error {
  readonly code: VisionErrorCode
  constructor(code: VisionErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'VisionError'
    this.code = code
  }
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
