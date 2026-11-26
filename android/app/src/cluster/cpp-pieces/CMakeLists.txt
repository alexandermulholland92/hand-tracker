# This phone's own libtorrent for the Cluster app (pieces_jni.cpp, and the part-runner both phone apps share,
# cluster/pieces-native/ht_pieces.cpp): libtorrent (its own source, LT_SRC, built here as a static library with Boost's
# headers, BOOST_INCLUDE, and its own crypto: no OpenSSL) as one library the app loads, libpieces_jni.so.
# scripts/build-libtorrent-android.js runs it with the NDK's toolchain.
cmake_minimum_required(VERSION 3.18)
project(pieces_jni C CXX)

if(NOT LT_SRC OR NOT BOOST_INCLUDE)
    message(FATAL_ERROR "LT_SRC: libtorrent's source folder; BOOST_INCLUDE: Boost's headers")
endif()

set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(Boost_INCLUDE_DIR ${BOOST_INCLUDE} CACHE PATH "" FORCE)
set(Boost_NO_BOOST_CMAKE ON CACHE BOOL "" FORCE)
set(Boost_NO_SYSTEM_PATHS ON CACHE BOOL "" FORCE)
add_subdirectory(${LT_SRC} libtorrent EXCLUDE_FROM_ALL)

set(NATIVE ${CMAKE_CURRENT_SOURCE_DIR}/../../../../../cluster/pieces-native)
add_library(pieces_jni SHARED pieces_jni.cpp ${NATIVE}/ht_pieces.cpp)
target_include_directories(pieces_jni PRIVATE ${NATIVE})
target_link_libraries(pieces_jni PRIVATE torrent-rasterbar log)
set_target_properties(pieces_jni PROPERTIES CXX_STANDARD 17 CXX_STANDARD_REQUIRED ON)
