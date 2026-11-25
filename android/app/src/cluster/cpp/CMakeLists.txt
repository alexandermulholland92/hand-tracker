# This phone's own Transmission for the Cluster app (transmission_jni.cpp): libtransmission (Transmission's own
# source, TR_SRC, built here with its own options: only the library, mbedTLS for its crypto) and curl and mbedTLS
# (built first, found through CMAKE_PREFIX_PATH), as one library the app loads. scripts/build-transmission-android.js
# runs it with the NDK's toolchain.
cmake_minimum_required(VERSION 3.18)
project(transmission_jni C CXX)

if(NOT TR_SRC)
    message(FATAL_ERROR "TR_SRC: Transmission's source folder")
endif()

add_subdirectory(${TR_SRC} transmission EXCLUDE_FROM_ALL)

add_library(transmission_jni SHARED transmission_jni.cpp)
target_link_libraries(transmission_jni PRIVATE transmission log)
# (its own C++ library inside it: the app's other native parts bring theirs)
set_target_properties(transmission_jni PROPERTIES CXX_STANDARD 17 CXX_STANDARD_REQUIRED ON)
