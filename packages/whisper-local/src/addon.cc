// N-API binding for vendored whisper.cpp.
//
// Memory-safety design (see docs/DEV.md for full rationale):
//   - TranscribeWorker holds a Napi::ObjectReference (Persistent) to its
//     parent WhisperModel JS object. This pins the model alive across the
//     async boundary, so JS GC cannot collect it while a worker is queued.
//   - WhisperModel owns a std::mutex. TranscribeWorker::Execute locks it,
//     so concurrent transcribe() calls on the same model serialize cleanly
//     instead of racing on whisper_full's internal state.
//   - WhisperModel owns an atomic in-flight counter. Free() refuses (throws
//     a JS error) when in-flight is non-zero. The destructor is a safety
//     net only; given the Persistent ref it should never run while busy.
//   - Errors raised inside Execute() use SetError() (NOT C++ throw, which
//     is undefined off the JS thread). OnError translates to JS rejection.
//   - PCM data is COPIED from the JS-managed Float32Array into a heap
//     std::vector<float> before queuing, so the JS buffer can be GC'd.
//   - Float32Array.ElementLength() is the float count, NOT byte count.
//     Using ByteLength() here would over-read by 4x.

#include <napi.h>
#include <whisper.h>
#include <atomic>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

class WhisperModel; // forward

class TranscribeWorker : public Napi::AsyncWorker {
 public:
  TranscribeWorker(Napi::Env env,
                   Napi::Promise::Deferred deferred,
                   Napi::ObjectReference modelRef,
                   WhisperModel* model,
                   std::vector<float> pcm,
                   std::string language,
                   bool translate);

  ~TranscribeWorker() override;

  void Execute() override;
  void OnOK() override;
  void OnError(const Napi::Error& err) override;

 private:
  Napi::Promise::Deferred deferred_;
  Napi::ObjectReference modelRef_; // pins the WhisperModel JS object alive
  WhisperModel* model_;
  std::vector<float> pcm_;
  std::string language_;
  bool translate_;
  std::vector<std::string> segments_;
};

class WhisperModel : public Napi::ObjectWrap<WhisperModel> {
 public:
  static Napi::Object Init(Napi::Env env, Napi::Object exports);
  WhisperModel(const Napi::CallbackInfo& info);
  ~WhisperModel();

  whisper_context* ctx() { return ctx_; }
  std::mutex& mutex() { return mu_; }
  void incInflight() { inflight_.fetch_add(1, std::memory_order_acq_rel); }
  void decInflight() { inflight_.fetch_sub(1, std::memory_order_acq_rel); }

 private:
  whisper_context* ctx_ = nullptr;
  std::mutex mu_;
  std::atomic<int> inflight_{0};

  Napi::Value Free(const Napi::CallbackInfo& info);
  Napi::Value Transcribe(const Napi::CallbackInfo& info);
};

// ---------------- WhisperModel ----------------

WhisperModel::WhisperModel(const Napi::CallbackInfo& info)
    : Napi::ObjectWrap<WhisperModel>(info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "loadModel(path: string) requires a string path")
        .ThrowAsJavaScriptException();
    return;
  }

  std::string path = info[0].As<Napi::String>().Utf8Value();
  whisper_context_params params = whisper_context_default_params();
  // params.use_gpu defaults to true; whisper.cpp falls back to CPU if no GPU.

  ctx_ = whisper_init_from_file_with_params(path.c_str(), params);
  if (ctx_ == nullptr) {
    Napi::Error::New(env,
                     "whisper_init_from_file_with_params failed for: " + path)
        .ThrowAsJavaScriptException();
  }
}

WhisperModel::~WhisperModel() {
  // By the time the destructor runs, no JS references exist (Napi::ObjectWrap
  // semantics) and no in-flight worker can hold a Persistent ref to us. So
  // inflight_ MUST be zero. Defensive check below avoids a use-after-free if
  // an unforeseen lifecycle bug ever leaves a worker in flight; we leak the
  // ctx in that case, which is preferable to a crash.
  if (inflight_.load(std::memory_order_acquire) == 0 && ctx_ != nullptr) {
    whisper_free(ctx_);
    ctx_ = nullptr;
  }
}

Napi::Value WhisperModel::Free(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (inflight_.load(std::memory_order_acquire) != 0) {
    Napi::Error::New(env,
                     "WhisperModel busy: free() called while transcribe() is "
                     "in flight. Await all pending transcribe() promises "
                     "before calling free().")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  std::lock_guard<std::mutex> lock(mu_);
  if (ctx_ != nullptr) {
    whisper_free(ctx_);
    ctx_ = nullptr;
  }
  return env.Undefined();
}

Napi::Value WhisperModel::Transcribe(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::HandleScope scope(env);

  if (ctx_ == nullptr) {
    Napi::Error::New(env, "WhisperModel has been freed")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  if (info.Length() < 1 || !info[0].IsTypedArray()) {
    Napi::TypeError::New(
        env, "transcribe(pcm: Float32Array, opts?) requires a Float32Array")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  Napi::TypedArray ta = info[0].As<Napi::TypedArray>();
  if (ta.TypedArrayType() != napi_float32_array) {
    Napi::TypeError::New(env, "pcm must be a Float32Array")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  Napi::Float32Array f32 = ta.As<Napi::Float32Array>();

  // ElementLength is the float count, NOT byte count. Copy into a heap vector
  // so the JS-managed buffer can be GC'd before Execute() runs.
  const float* src = f32.Data();
  const size_t n = f32.ElementLength();
  std::vector<float> pcm(src, src + n);

  std::string language;
  bool translate = false;
  if (info.Length() >= 2 && info[1].IsObject()) {
    Napi::Object opts = info[1].As<Napi::Object>();
    if (opts.Has("language") && opts.Get("language").IsString()) {
      language = opts.Get("language").As<Napi::String>().Utf8Value();
    }
    if (opts.Has("translate") && opts.Get("translate").IsBoolean()) {
      translate = opts.Get("translate").As<Napi::Boolean>().Value();
    }
  }

  Napi::Promise::Deferred deferred = Napi::Promise::Deferred::New(env);

  // Persistent reference to `this` keeps the JS WhisperModel object alive
  // across the async boundary even if JS drops all other refs.
  Napi::ObjectReference modelRef =
      Napi::Persistent(info.This().As<Napi::Object>());

  auto* worker =
      new TranscribeWorker(env, deferred, std::move(modelRef), this,
                           std::move(pcm), std::move(language), translate);
  worker->Queue();
  return deferred.Promise();
}

Napi::Object WhisperModel::Init(Napi::Env env, Napi::Object exports) {
  Napi::Function func = DefineClass(env, "WhisperModel", {
    InstanceMethod("transcribe", &WhisperModel::Transcribe),
    InstanceMethod("free", &WhisperModel::Free),
  });
  exports.Set("WhisperModel", func);
  return exports;
}

// ---------------- TranscribeWorker ----------------

TranscribeWorker::TranscribeWorker(Napi::Env env,
                                   Napi::Promise::Deferred deferred,
                                   Napi::ObjectReference modelRef,
                                   WhisperModel* model,
                                   std::vector<float> pcm,
                                   std::string language,
                                   bool translate)
    : Napi::AsyncWorker(env),
      deferred_(deferred),
      modelRef_(std::move(modelRef)),
      model_(model),
      pcm_(std::move(pcm)),
      language_(std::move(language)),
      translate_(translate) {
  model_->incInflight();
}

TranscribeWorker::~TranscribeWorker() {
  model_->decInflight();
  // modelRef_ is reset by ObjectReference's destructor on the JS thread.
}

void TranscribeWorker::Execute() {
  // Serialize calls on the same context. whisper_full mutates ctx state, so
  // two concurrent calls would race.
  std::lock_guard<std::mutex> lock(model_->mutex());
  whisper_context* ctx = model_->ctx();
  if (ctx == nullptr) {
    SetError("WhisperModel was freed before transcribe could run");
    return;
  }

  whisper_full_params params =
      whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
  params.print_progress = false;
  params.print_realtime = false;
  params.print_timestamps = false;
  params.print_special = false;
  params.translate = translate_;
  params.language = language_.empty() ? "auto" : language_.c_str();

  int rc =
      whisper_full(ctx, params, pcm_.data(), static_cast<int>(pcm_.size()));
  if (rc != 0) {
    SetError("whisper_full returned non-zero status " + std::to_string(rc));
    return;
  }

  int n = whisper_full_n_segments(ctx);
  segments_.reserve(static_cast<size_t>(n));
  for (int i = 0; i < n; ++i) {
    const char* text = whisper_full_get_segment_text(ctx, i);
    if (text != nullptr) {
      segments_.emplace_back(text); // copies into std::string
    }
  }
}

void TranscribeWorker::OnOK() {
  Napi::Env env = Env();
  Napi::HandleScope scope(env);
  Napi::Array arr = Napi::Array::New(env, segments_.size());
  for (size_t i = 0; i < segments_.size(); ++i) {
    arr.Set(static_cast<uint32_t>(i), Napi::String::New(env, segments_[i]));
  }
  deferred_.Resolve(arr);
}

void TranscribeWorker::OnError(const Napi::Error& err) {
  deferred_.Reject(err.Value());
}

// ---------------- module init ----------------

Napi::Object InitAll(Napi::Env env, Napi::Object exports) {
  WhisperModel::Init(env, exports);
  return exports;
}

NODE_API_MODULE(whisper_addon, InitAll)
