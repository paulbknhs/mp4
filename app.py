import os
import uuid
import subprocess
from flask import Flask, render_template, request, jsonify, send_from_directory, after_this_request, url_for
import ffmpeg
import logging

# --- Configuration ---
app = Flask(__name__)
app.config['UPLOAD_FOLDER'] = 'uploads'
app.config['PROCESSED_FOLDER'] = 'processed'
app.config['MAX_CONTENT_LENGTH'] = 100 * 1024 * 1024  # 100 MB limit (adjust as needed)
ALLOWED_EXTENSIONS = {'mp4'}

# Setup basic logging
logging.basicConfig(level=logging.INFO)
app.logger.setLevel(logging.INFO)


# --- Helper Functions ---

def allowed_file(filename):
    return '.' in filename and \
           filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS

def cleanup_file(path):
    """Remove a file if it exists."""
    if not path or not os.path.exists(path):
        app.logger.warning(f"Cleanup attempted on non-existent path: {path}")
        return
    try:
        app.logger.info(f"Attempting to clean up: {path}")
        os.remove(path)
        app.logger.info(f"Successfully cleaned up: {path}")
    except OSError as e:
        app.logger.error(f"Error removing file {path}: {e}")
    except Exception as e:
        app.logger.error(f"Unexpected error during cleanup of {path}: {e}")


# --- Routes ---

@app.route('/')
def index():
    """Render the main page."""
    return render_template('index.html')

@app.route('/process', methods=['POST'])
def process_video():
    """Handle file upload and processing (normalize or volume adjust)."""
    if 'file' not in request.files:
        return jsonify({"error": "No file part"}), 400
    file = request.files['file']
    if file.filename == '':
        return jsonify({"error": "No selected file"}), 400

    if file and allowed_file(file.filename):
        # Ensure upload/processed directories exist
        os.makedirs(app.config['UPLOAD_FOLDER'], exist_ok=True)
        os.makedirs(app.config['PROCESSED_FOLDER'], exist_ok=True)

        # --- File Saving ---
        original_filename = file.filename # Keep original for history
        ext = original_filename.rsplit('.', 1)[1].lower()
        unique_id = str(uuid.uuid4())
        temp_original_filename = f"{unique_id}_orig.{ext}" # Temp name for original
        original_path = os.path.join(app.config['UPLOAD_FOLDER'], temp_original_filename)
        processed_filename = f"{unique_id}_proc.{ext}" # Unique name for processed
        processed_path = os.path.join(app.config['PROCESSED_FOLDER'], processed_filename)

        try:
            file.save(original_path)
            app.logger.info(f"Uploaded file saved to: {original_path}")
        except Exception as e:
            app.logger.error(f"Error saving uploaded file: {e}")
            return jsonify({"error": f"Failed to save uploaded file: {e}"}), 500

        # --- Processing Logic ---
        operation = request.form.get('operation') # 'normalize' or 'volume'
        output_url = None
        error_message = None

        try:
            app.logger.info(f"Processing '{original_filename}' with operation: {operation}")
            input_stream = ffmpeg.input(original_path)
            # Explicitly select streams to avoid ambiguity if multiple exist
            audio_stream = input_stream['a:0'] # Select first audio stream
            video_stream = input_stream['v:0'] # Select first video stream

            if operation == 'normalize':
                app.logger.info("Applying normalization (loudnorm filter)")
                # Target Integrated Loudness: -16 LUFS, True Peak: -1.5 dBTP, LRA: 11 LU
                processed_audio = audio_stream.filter('loudnorm', i='-16', tp='-1.5', lra='11', print_format='json')

            elif operation == 'volume':
                volume_level = float(request.form.get('volume', 1.0))
                app.logger.info(f"Applying volume adjustment: {volume_level}")
                if volume_level <= 0: # Prevent silence or invalid values
                    volume_level = 0.01
                # Use 'volume' filter; value can be a number (multiplier) or dB value (e.g., '3dB')
                processed_audio = audio_stream.filter('volume', volume=str(volume_level))

            else:
                error_message = "Invalid operation specified."
                raise ValueError(error_message)

            # --- Re-combine and Output ---
            # Copy video stream, re-encode audio (AAC is standard for MP4)
            app.logger.info(f"Starting ffmpeg processing to: {processed_path}")
            (
                ffmpeg
                .output(
                    video_stream,      # The original video stream
                    processed_audio,   # The filtered audio stream
                    processed_path,
                    acodec='aac',      # Common audio codec for MP4
                    vcodec='copy',     # Crucial: Copy video without re-encoding
                    # audio_bitrate='192k' # Optional: set audio bitrate
                )
                .overwrite_output() # Allow overwriting if file exists (shouldn't with UUIDs)
                .run(capture_stdout=True, capture_stderr=True) # Capture output for debugging
            )
            app.logger.info(f"ffmpeg processing finished for {processed_filename}")

            # Schedule cleanup of the *temporary original* file after request
            @after_this_request
            def cleanup_original(response):
                cleanup_file(original_path)
                return response

            output_url = url_for('serve_processed_file', filename=processed_filename, _external=False) # Relative URL for preview/waveform

        except ffmpeg.Error as e:
            stderr_output = e.stderr.decode() if e.stderr else 'Unknown ffmpeg error'
            error_message = f"ffmpeg error: {stderr_output}"
            app.logger.error(f"ffmpeg error during processing: {error_message}")
            # Clean up temp original immediately on error
            cleanup_file(original_path)
            # Attempt to clean up partially processed file if it exists
            cleanup_file(processed_path)

        except Exception as e:
            error_message = f"An unexpected error occurred: {str(e)}"
            app.logger.error(error_message, exc_info=True) # Log full traceback
             # Clean up temp original immediately on error
            cleanup_file(original_path)
            # Attempt to clean up partially processed file if it exists
            cleanup_file(processed_path)

        # --- Response ---
        if error_message:
             return jsonify({"error": error_message}), 500
        else:
            # Return necessary info for frontend (preview, download, history)
            return jsonify({
                 "message": f"Processing successful ({operation})",
                 "processed_url": output_url, # Relative URL for JS
                 "processed_filename": processed_filename, # Filename for download route
                 "original_filename": original_filename # Original name for history display
             })

    else:
        return jsonify({"error": "File type not allowed"}), 400


@app.route('/serve/<path:filename>')
def serve_processed_file(filename):
    """Serve processed files for preview or download."""
    # IMPORTANT CAVEAT: NO AUTOMATIC CLEANUP HERE FOR HISTORY
    # Implement a separate cleanup mechanism (e.g., cron job) in production!
    file_path = os.path.join(app.config['PROCESSED_FOLDER'], filename)

    # Basic security check: prevent path traversal
    if '..' in filename or filename.startswith('/'):
        app.logger.warning(f"Attempted path traversal: {filename}")
        return jsonify({"error": "Invalid filename"}), 400

    if not os.path.exists(file_path):
        app.logger.error(f"Attempted to serve non-existent file: {filename}")
        return jsonify({"error": "File not found or may have been cleaned up."}), 404

    app.logger.info(f"Serving file: {filename}")
    # Use send_from_directory for security; as_attachment=False for preview/streaming
    return send_from_directory(app.config['PROCESSED_FOLDER'], filename, as_attachment=False)


@app.route('/download/<path:filename>')
def download_processed_file(filename):
    """Force download of a processed file."""
    # IMPORTANT CAVEAT: NO AUTOMATIC CLEANUP HERE FOR HISTORY
    file_path = os.path.join(app.config['PROCESSED_FOLDER'], filename)

    # Basic security check
    if '..' in filename or filename.startswith('/'):
        app.logger.warning(f"Attempted path traversal for download: {filename}")
        return jsonify({"error": "Invalid filename"}), 400

    if not os.path.exists(file_path):
        app.logger.error(f"Attempted to download non-existent file: {filename}")
        return jsonify({"error": "File not found or may have been cleaned up."}), 404

    # Try to create a user-friendly download name
    try:
        # Assuming format uniqueid_proc.ext - get part after first '_'
        original_name_part = filename.split('_', 1)[-1]
        download_name = f"processed_{original_name_part}"
    except:
        download_name = f"processed_{filename}" # Fallback

    app.logger.info(f"Initiating download for: {filename} as {download_name}")
    # as_attachment=True forces download dialog
    return send_from_directory(app.config['PROCESSED_FOLDER'], filename, as_attachment=True, download_name=download_name)


if __name__ == '__main__':
    # Create directories if they don't exist at startup
    os.makedirs(app.config['UPLOAD_FOLDER'], exist_ok=True)
    os.makedirs(app.config['PROCESSED_FOLDER'], exist_ok=True)
    app.logger.info("Starting Flask application...")
    app.run(debug=True, host='0.0.0.0', port=5000) # Run in debug mode, accessible on network