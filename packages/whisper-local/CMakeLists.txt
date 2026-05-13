cmake_minimum_required(VERSION 3.18)
project(whisper_addon)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

# --- whisper.cpp + ggml as static libs ---
set(WHISPER_BUILD_TESTS    OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_SERVER   OFF CACHE BOOL "" FORCE)
set(GGML_BLAS  OFF CACHE BOOL "" FORCE)

# Build whisper as a static lib so we can link it into the addon .node file.
set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)

# macOS: enable Metal acceleration (free, no API surface needed)
if(APPLE)
  set(GGML_METAL ON CACHE BOOL "" FORCE)
  set(GGML_METAL_EMBED_LIBRARY ON CACHE BOOL "" FORCE)
else()
  set(GGML_METAL OFF CACHE BOOL "" FORCE)
endif()

# Pull in the whole vendored whisper.cpp tree using its own top-level CMakeLists.
add_subdirectory(vendor/whisper.cpp)

# --- N-API addon ---
include_directories(${CMAKE_JS_INC})

file(GLOB ADDON_SOURCES "src/addon.cc")
add_library(${PROJECT_NAME} SHARED ${ADDON_SOURCES} ${CMAKE_JS_SRC})
set_target_properties(${PROJECT_NAME} PROPERTIES PREFIX "" SUFFIX ".node")

target_include_directories(${PROJECT_NAME} PRIVATE
  vendor/whisper.cpp/include
  vendor/whisper.cpp/ggml/include
)

target_link_libraries(${PROJECT_NAME} PRIVATE whisper ${CMAKE_JS_LIB})

# node-addon-api headers
execute_process(
  COMMAND node -p "require('node-addon-api').include"
  WORKING_DIRECTORY ${CMAKE_SOURCE_DIR}
  OUTPUT_VARIABLE NODE_ADDON_API_DIR
  OUTPUT_STRIP_TRAILING_WHITESPACE
)
string(REGEX REPLACE "\"" "" NODE_ADDON_API_DIR ${NODE_ADDON_API_DIR})
target_include_directories(${PROJECT_NAME} PRIVATE ${NODE_ADDON_API_DIR})
add_definitions(-DNAPI_VERSION=8)
